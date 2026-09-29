use crate::config::Config;
use anyhow::{Result, bail, ensure};
use mediasoup::consumer::{Consumer, ConsumerId, ConsumerOptions};
use mediasoup::prelude::*;
use mediasoup::producer::{Producer, ProducerId, ProducerOptions};
use mediasoup::types::data_structures::{ListenInfo, Protocol};
use mediasoup::types::rtp_parameters::{
    MediaKind, MimeTypeAudio, MimeTypeVideo, RtcpFeedback, RtpCapabilities, RtpCodecCapability,
    RtpCodecParametersParameters, RtpParameters,
};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{HashMap, VecDeque};
use std::num::{NonZeroU8, NonZeroU32};
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use subtle::ConstantTimeEq;
use tokio::sync::watch;

#[derive(Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Publisher,
    Viewer,
}

#[derive(Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Direction {
    Send,
    Recv,
}

#[derive(Deserialize)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Action {
    Join {
        role: Role,
        key: String,
        headset_id: Option<String>,
    },
    ListFeeds,
    CreateTransport {
        direction: Direction,
    },
    ConnectTransport {
        transport_id: TransportId,
        dtls_parameters: mediasoup::types::data_structures::DtlsParameters,
    },
    Produce {
        transport_id: TransportId,
        kind: MediaKind,
        rtp_parameters: RtpParameters,
    },
    StartIngest,
    Stats,
    Consume {
        transport_id: TransportId,
        producer_id: ProducerId,
        rtp_capabilities: RtpCapabilities,
    },
    ResumeConsumer {
        consumer_id: ConsumerId,
    },
    PauseConsumer {
        consumer_id: ConsumerId,
    },
    CloseConsumer {
        consumer_id: ConsumerId,
    },
    CloseTransport {
        transport_id: TransportId,
    },
}

#[derive(Deserialize)]
pub struct Request {
    pub id: u64,
    #[serde(flatten)]
    pub action: Action,
}

struct Headset {
    audio: Option<ProducerId>,
    video: Option<ProducerId>,
    stats: Option<Value>,
    connected_at: Instant,
    stats_at: Option<Instant>,
    control_rtt_ms: Option<u64>,
}

impl Default for Headset {
    fn default() -> Self {
        Self {
            audio: None,
            video: None,
            stats: None,
            connected_at: Instant::now(),
            stats_at: None,
            control_rtt_ms: None,
        }
    }
}

impl Headset {
    fn track(&mut self, kind: MediaKind) -> &mut Option<ProducerId> {
        match kind {
            MediaKind::Audio => &mut self.audio,
            MediaKind::Video => &mut self.video,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Feed {
    headset_id: String,
    video: Option<ProducerId>,
    audio: Option<ProducerId>,
}

#[derive(Default)]
struct Room {
    headsets: HashMap<String, Headset>,
    viewers: usize,
}

/// Owns the native media worker and the one-room feed registry
pub struct Relay {
    worker: Worker,
    router: Router,
    rtc: WebRtcServer,
    room: Mutex<Room>,
    updates: watch::Sender<u64>,
    started_at: Instant,
    history: Mutex<VecDeque<Value>>,
    config: Config,
}

impl Relay {
    pub async fn start(config: Config) -> Result<Arc<Self>> {
        let manager = WorkerManager::new();
        let worker = manager.create_worker(WorkerSettings::default()).await?;
        let mut h264 = RtpCodecParametersParameters::default();
        h264.insert("packetization-mode", 1u8)
            .insert("profile-level-id", "42e01f")
            .insert("level-asymmetry-allowed", 1u8);
        let router = worker
            .create_router(RouterOptions::new(vec![
                RtpCodecCapability::Audio {
                    mime_type: MimeTypeAudio::Opus,
                    preferred_payload_type: None,
                    clock_rate: NonZeroU32::new(48_000).expect("fixed clock rate is nonzero"),
                    channels: NonZeroU8::new(2).expect("fixed channel count is nonzero"),
                    parameters: RtpCodecParametersParameters::default(),
                    rtcp_feedback: vec![RtcpFeedback::TransportCc],
                },
                RtpCodecCapability::Video {
                    mime_type: MimeTypeVideo::H264,
                    preferred_payload_type: None,
                    clock_rate: NonZeroU32::new(90_000).expect("fixed clock rate is nonzero"),
                    parameters: h264,
                    rtcp_feedback: vec![
                        RtcpFeedback::Nack,
                        RtcpFeedback::NackPli,
                        RtcpFeedback::CcmFir,
                        RtcpFeedback::GoogRemb,
                        RtcpFeedback::TransportCc,
                    ],
                },
            ]))
            .await?;
        let listen = |protocol| ListenInfo {
            protocol,
            ip: config.rtc_ip,
            announced_address: config.announced_address.clone(),
            expose_internal_ip: false,
            port: Some(config.rtc_port),
            port_range: None,
            flags: None,
            send_buffer_size: None,
            recv_buffer_size: None,
        };
        let rtc = worker
            .create_webrtc_server(WebRtcServerOptions::new(
                WebRtcServerListenInfos::new(listen(Protocol::Udp)).insert(listen(Protocol::Tcp)),
            ))
            .await?;
        let (updates, _) = watch::channel(0);
        let relay = Arc::new(Self {
            worker,
            router,
            rtc,
            room: Mutex::new(Room::default()),
            updates,
            started_at: Instant::now(),
            history: Mutex::new(VecDeque::with_capacity(180)),
            config,
        });
        relay.sample_health();
        let weak = Arc::downgrade(&relay);
        tokio::spawn(async move {
            let mut timer = tokio::time::interval(Duration::from_secs(5));
            timer.tick().await;
            while let Some(relay) = weak.upgrade() {
                timer.tick().await;
                relay.sample_health();
            }
        });
        Ok(relay)
    }

    pub fn healthy(&self) -> bool {
        !self.worker.closed()
    }

    pub fn feeds(&self) -> Vec<Feed> {
        let mut feeds: Vec<_> = self
            .room
            .lock()
            .headsets
            .iter()
            .filter(|(_, headset)| headset.video.is_some() || headset.audio.is_some())
            .map(|(headset_id, headset)| Feed {
                headset_id: headset_id.clone(),
                video: headset.video,
                audio: headset.audio,
            })
            .collect();
        feeds.sort_unstable_by(|a, b| a.headset_id.cmp(&b.headset_id));
        feeds
    }

    pub fn admin_snapshot(&self) -> Value {
        let room = self.room.lock();
        let mut headsets: Vec<_> = room
            .headsets
            .iter()
            .map(|(id, headset)| {
                json!({
                    "id": id,
                    "video": headset.video,
                    "audio": headset.audio,
                    "stats": headset.stats,
                    "connectedSeconds": headset.connected_at.elapsed().as_secs(),
                    "statsAgeMs": headset.stats_at.map(|at| at.elapsed().as_millis() as u64),
                    "controlRttMs": headset.control_rtt_ms,
                })
            })
            .collect();
        headsets.sort_unstable_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
        json!({
            "headsets": headsets,
            "viewers": room.viewers,
            "healthy": self.healthy(),
            "uptimeSeconds": self.started_at.elapsed().as_secs(),
            "history": self.history.lock().clone(),
            "rtcPort": self.config.rtc_port,
            "announcedAddress": self.config.announced_address,
        })
    }

    fn sample_health(&self) {
        let room = self.room.lock();
        let at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        let sample = json!({
            "at": at,
            "healthy": self.healthy(),
            "headsets": room.headsets.len(),
            "viewers": room.viewers,
        });
        drop(room);
        let mut history = self.history.lock();
        if history.len() == 180 {
            history.pop_front();
        }
        history.push_back(sample);
    }

    pub fn publisher_key(&self) -> &str {
        &self.config.publisher_key
    }

    pub fn subscribe(&self) -> watch::Receiver<u64> {
        self.updates.subscribe()
    }

    fn changed(&self) {
        self.updates
            .send_modify(|revision| *revision = revision.wrapping_add(1));
    }

    pub fn join(self: &Arc<Self>, action: Action) -> Result<(Peer, Value)> {
        let Action::Join {
            role,
            key,
            headset_id,
        } = action
        else {
            bail!("Join required");
        };
        ensure!(self.healthy(), "Media worker unavailable");
        let expected = match role {
            Role::Publisher => &self.config.publisher_key,
            Role::Viewer => &self.config.viewer_key,
        };
        ensure!(
            key.len() == expected.len() && bool::from(key.as_bytes().ct_eq(expected.as_bytes())),
            "Invalid access key"
        );
        let mut room = self.room.lock();
        if role == Role::Publisher {
            let id = headset_id
                .as_deref()
                .ok_or_else(|| anyhow::anyhow!("headsetId required"))?;
            ensure!(
                !id.is_empty()
                    && id.len() <= 64
                    && id
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-'),
                "Invalid headsetId"
            );
            ensure!(!room.headsets.contains_key(id), "Headset already connected");
            ensure!(
                room.headsets.len() < self.config.max_headsets,
                "Headset capacity reached"
            );
            room.headsets.insert(id.to_owned(), Headset::default());
        } else {
            ensure!(
                room.viewers < self.config.max_viewers,
                "Viewer capacity reached"
            );
            room.viewers += 1;
        }
        drop(room);
        let peer = Peer {
            relay: Arc::clone(self),
            role,
            headset_id,
            transports: HashMap::new(),
            ingest: None,
            producers: HashMap::new(),
            consumers: HashMap::new(),
        };
        let data =
            json!({"rtpCapabilities": self.router.rtp_capabilities(), "feeds": self.feeds()});
        Ok((peer, data))
    }

    fn producer_closed(&self, headset_id: &str, kind: MediaKind, producer_id: ProducerId) {
        let changed = {
            let mut room = self.room.lock();
            room.headsets.get_mut(headset_id).is_some_and(|headset| {
                let track = headset.track(kind);
                if *track == Some(producer_id) {
                    *track = None;
                    true
                } else {
                    false
                }
            })
        };
        if changed {
            self.changed();
        }
    }
}

pub struct Peer {
    relay: Arc<Relay>,
    role: Role,
    headset_id: Option<String>,
    transports: HashMap<TransportId, (WebRtcTransport, Direction)>,
    ingest: Option<DirectTransport>,
    producers: HashMap<MediaKind, Producer>,
    consumers: HashMap<ConsumerId, Consumer>,
}

fn ingest_parameters(kind: MediaKind) -> Result<RtpParameters> {
    let (mime, payload_type, clock_rate, ssrc, channels, parameters) = match kind {
        MediaKind::Video => (
            "video/H264",
            102,
            90_000,
            10_001,
            Value::Null,
            json!({
                "packetization-mode": 1,
                "profile-level-id": "42e01f",
                "level-asymmetry-allowed": 1,
            }),
        ),
        MediaKind::Audio => ("audio/opus", 111, 48_000, 10_002, json!(2), json!({})),
    };
    Ok(serde_json::from_value(json!({
        "codecs": [{
            "mimeType": mime,
            "payloadType": payload_type,
            "clockRate": clock_rate,
            "channels": channels,
            "parameters": parameters,
            "rtcpFeedback": [],
        }],
        "headerExtensions": [],
        "encodings": [{"ssrc": ssrc}],
        "rtcp": {"cname": "questrelay", "reducedSize": true},
    }))?)
}

impl Peer {
    pub fn record_control_rtt(&self, elapsed: Duration) {
        if let Some(id) = &self.headset_id
            && let Some(headset) = self.relay.room.lock().headsets.get_mut(id)
        {
            headset.control_rtt_ms = Some(elapsed.as_millis() as u64);
        }
    }

    pub fn handle_closed(&mut self) {
        self.transports
            .retain(|_, (transport, _)| !transport.closed());
        self.producers.retain(|_, producer| !producer.closed());
        self.consumers.retain(|_, consumer| !consumer.closed());
    }

    fn transport(
        &self,
        id: &TransportId,
        direction: Option<Direction>,
    ) -> Result<&WebRtcTransport> {
        let (transport, owned_direction) = self
            .transports
            .get(id)
            .ok_or_else(|| anyhow::anyhow!("Transport not found"))?;
        ensure!(
            !transport.closed() && direction.is_none_or(|direction| direction == *owned_direction),
            "Transport not found"
        );
        Ok(transport)
    }

    fn register_producer(&mut self, kind: MediaKind, producer: Producer) -> ProducerId {
        let producer_id = producer.id();
        let headset_id = self
            .headset_id
            .as_ref()
            .expect("publisher has a headset identity")
            .clone();
        let weak: Weak<Relay> = Arc::downgrade(&self.relay);
        producer
            .on_close(move || {
                if let Some(relay) = weak.upgrade() {
                    relay.producer_closed(&headset_id, kind, producer_id);
                }
            })
            .detach();
        if let Some(headset) = self
            .relay
            .room
            .lock()
            .headsets
            .get_mut(self.headset_id.as_deref().unwrap_or_default())
        {
            *headset.track(kind) = Some(producer_id);
        }
        self.producers.insert(kind, producer);
        producer_id
    }

    pub fn ingest_rtp(&self, packet: Vec<u8>) -> Result<()> {
        ensure!(
            (13..=1200).contains(&packet.len()) && packet[0] == 0x80,
            "Invalid RTP packet"
        );
        let kind = match packet[1] & 0x7f {
            102 => MediaKind::Video,
            111 => MediaKind::Audio,
            _ => bail!("Unsupported RTP payload type"),
        };
        let expected_ssrc: u32 = if kind == MediaKind::Video {
            10_001
        } else {
            10_002
        };
        ensure!(
            packet[8..12] == expected_ssrc.to_be_bytes(),
            "Invalid RTP source"
        );
        let Some(Producer::Direct(producer)) = self.producers.get(&kind) else {
            bail!("Ingest not started");
        };
        producer.send(packet)?;
        Ok(())
    }

    pub async fn handle(&mut self, action: Action) -> Result<Value> {
        ensure!(self.relay.healthy(), "Media worker unavailable");
        self.handle_closed();
        match action {
            Action::Join { .. } => bail!("Already joined"),
            Action::ListFeeds => Ok(json!({"feeds": self.relay.feeds()})),
            Action::CreateTransport { direction } => {
                ensure!(
                    (direction == Direction::Send) == (self.role == Role::Publisher),
                    "Direction not allowed for this role"
                );
                ensure!(
                    !self
                        .transports
                        .values()
                        .any(|(_, owned)| *owned == direction),
                    "Transport already exists"
                );
                ensure!(
                    direction != Direction::Send || self.ingest.is_none(),
                    "Ingest already active"
                );
                let mut options = WebRtcTransportOptions::new_with_server(self.relay.rtc.clone());
                options.prefer_udp = true;
                let transport = self.relay.router.create_webrtc_transport(options).await?;
                let data = json!({
                    "id": transport.id(),
                    "iceParameters": transport.ice_parameters(),
                    "iceCandidates": transport.ice_candidates(),
                    "dtlsParameters": transport.dtls_parameters(),
                });
                self.transports
                    .insert(transport.id(), (transport, direction));
                Ok(data)
            }
            Action::ConnectTransport {
                transport_id,
                dtls_parameters,
            } => {
                self.transport(&transport_id, None)?
                    .connect(WebRtcTransportRemoteParameters { dtls_parameters })
                    .await?;
                Ok(json!({"ok": true}))
            }
            Action::Produce {
                transport_id,
                kind,
                rtp_parameters,
            } => {
                ensure!(self.role == Role::Publisher, "Publish access required");
                ensure!(
                    !self.producers.contains_key(&kind),
                    "Media kind already published"
                );
                let producer = self
                    .transport(&transport_id, Some(Direction::Send))?
                    .produce(ProducerOptions::new(kind, rtp_parameters))
                    .await?;
                let producer_id = self.register_producer(kind, producer);
                self.relay.changed();
                Ok(json!({"id": producer_id}))
            }
            Action::StartIngest => {
                ensure!(self.role == Role::Publisher, "Publish access required");
                ensure!(
                    self.ingest.is_none()
                        && self.producers.is_empty()
                        && self.transports.is_empty(),
                    "Media already published"
                );
                let transport = self
                    .relay
                    .router
                    .create_direct_transport(DirectTransportOptions::default())
                    .await?;
                let video = transport
                    .produce(ProducerOptions::new(
                        MediaKind::Video,
                        ingest_parameters(MediaKind::Video)?,
                    ))
                    .await?;
                let audio = transport
                    .produce(ProducerOptions::new(
                        MediaKind::Audio,
                        ingest_parameters(MediaKind::Audio)?,
                    ))
                    .await?;
                self.ingest = Some(transport);
                let video_id = self.register_producer(MediaKind::Video, video);
                let audio_id = self.register_producer(MediaKind::Audio, audio);
                self.relay.changed();
                Ok(json!({
                    "video": {"producerId": video_id, "payloadType": 102, "ssrc": 10001},
                    "audio": {"producerId": audio_id, "payloadType": 111, "ssrc": 10002},
                }))
            }
            Action::Stats => {
                ensure!(self.role == Role::Publisher, "Publish access required");
                let mut tracks = serde_json::Map::new();
                for (kind, name) in [(MediaKind::Video, "video"), (MediaKind::Audio, "audio")] {
                    if let Some(producer) = self.producers.get(&kind) {
                        let stats = producer.get_stats().await?;
                        tracks.insert(
                            name.into(),
                            json!({
                                "packets": stats.iter().map(|stat| stat.packet_count).sum::<u64>(),
                                "bytes": stats.iter().map(|stat| stat.byte_count).sum::<u64>(),
                                "bitrate": stats.iter().map(|stat| stat.bitrate).sum::<u64>(),
                            }),
                        );
                    }
                }
                let data = Value::Object(tracks);
                if let Some(id) = &self.headset_id
                    && let Some(headset) = self.relay.room.lock().headsets.get_mut(id)
                {
                    headset.stats = Some(data.clone());
                    headset.stats_at = Some(Instant::now());
                }
                Ok(data)
            }
            Action::Consume {
                transport_id,
                producer_id,
                rtp_capabilities,
            } => {
                ensure!(self.role == Role::Viewer, "Viewer access required");
                let exists = self.relay.room.lock().headsets.values().any(|headset| {
                    headset.video == Some(producer_id) || headset.audio == Some(producer_id)
                });
                ensure!(exists, "Feed not found");
                ensure!(
                    !self
                        .consumers
                        .values()
                        .any(|consumer| consumer.producer_id() == producer_id),
                    "Feed already subscribed"
                );
                ensure!(
                    self.relay
                        .router
                        .can_consume(&producer_id, &rtp_capabilities),
                    "Unsupported media codec"
                );
                let mut options = ConsumerOptions::new(producer_id, rtp_capabilities);
                options.paused = true;
                let consumer = self
                    .transport(&transport_id, Some(Direction::Recv))?
                    .consume(options)
                    .await?;
                let data = json!({
                    "id": consumer.id(),
                    "producerId": consumer.producer_id(),
                    "kind": consumer.kind(),
                    "rtpParameters": consumer.rtp_parameters(),
                });
                self.consumers.insert(consumer.id(), consumer);
                Ok(data)
            }
            Action::ResumeConsumer { consumer_id } => {
                self.consumers
                    .get(&consumer_id)
                    .ok_or_else(|| anyhow::anyhow!("Consumer not found"))?
                    .resume()
                    .await?;
                Ok(json!({"ok": true}))
            }
            Action::PauseConsumer { consumer_id } => {
                self.consumers
                    .get(&consumer_id)
                    .ok_or_else(|| anyhow::anyhow!("Consumer not found"))?
                    .pause()
                    .await?;
                Ok(json!({"ok": true}))
            }
            Action::CloseConsumer { consumer_id } => {
                ensure!(
                    self.consumers.remove(&consumer_id).is_some(),
                    "Consumer not found"
                );
                Ok(json!({"ok": true}))
            }
            Action::CloseTransport { transport_id } => {
                let (_, direction) = self
                    .transports
                    .remove(&transport_id)
                    .ok_or_else(|| anyhow::anyhow!("Transport not found"))?;
                match direction {
                    Direction::Send => self.producers.clear(),
                    Direction::Recv => self.consumers.clear(),
                }
                Ok(json!({"ok": true}))
            }
        }
    }
}

impl Drop for Peer {
    fn drop(&mut self) {
        let mut room = self.relay.room.lock();
        match self.role {
            Role::Publisher => {
                if let Some(id) = &self.headset_id {
                    room.headsets.remove(id);
                }
            }
            Role::Viewer => room.viewers -= 1,
        }
        drop(room);
        if self.role == Role::Publisher {
            self.relay.changed();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket};

    #[test]
    fn accepts_camel_case_signalling_fields() -> Result<()> {
        let join: Request = serde_json::from_value(json!({
            "id": 7,
            "action": "join",
            "role": "publisher",
            "key": "test",
            "headsetId": "quest-a",
        }))?;
        assert!(
            matches!(join.action, Action::Join { headset_id: Some(id), .. } if id == "quest-a")
        );
        let close: Request = serde_json::from_value(json!({
            "id": 8,
            "action": "closeTransport",
            "transportId": "00000000-0000-0000-0000-000000000001",
        }))?;
        assert!(matches!(close.action, Action::CloseTransport { .. }));
        let ingest: Request = serde_json::from_value(json!({"id": 9, "action": "startIngest"}))?;
        assert!(matches!(ingest.action, Action::StartIngest));
        Ok(())
    }

    #[tokio::test]
    async fn direct_ingest_registers_both_tracks_and_rejects_other_packets() -> Result<()> {
        let socket = UdpSocket::bind("127.0.0.1:0")?;
        let port = socket.local_addr()?.port();
        drop(socket);
        let relay = Relay::start(Config {
            publisher_key: "publisher-secret-that-is-long-enough".into(),
            viewer_key: "viewer-secret-that-is-also-long-enough".into(),
            signal: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 8788),
            rtc_ip: IpAddr::V4(Ipv4Addr::LOCALHOST),
            rtc_port: port,
            announced_address: None,
            max_headsets: 2,
            max_viewers: 1,
        })
        .await?;
        let (mut publisher, _) = relay.join(Action::Join {
            role: Role::Publisher,
            key: relay.config.publisher_key.clone(),
            headset_id: Some("quest-a".into()),
        })?;
        let response = publisher.handle(Action::StartIngest).await?;
        let (mut second, _) = relay.join(Action::Join {
            role: Role::Publisher,
            key: relay.config.publisher_key.clone(),
            headset_id: Some("quest-b".into()),
        })?;
        second.handle(Action::StartIngest).await?;
        let (mut viewer, _) = relay.join(Action::Join {
            role: Role::Viewer,
            key: relay.config.viewer_key.clone(),
            headset_id: None,
        })?;
        assert!(viewer.handle(Action::Stats).await.is_err());
        assert_eq!(response["video"]["payloadType"], 102);
        assert_eq!(response["audio"]["payloadType"], 111);
        assert_eq!(relay.feeds().len(), 2);
        assert!(publisher.handle(Action::StartIngest).await.is_err());
        let mut packet = vec![0x80, 102, 0, 1, 0, 0, 0, 0, 0, 0, 0x27, 0x11, 0x65];
        publisher.ingest_rtp(packet.clone())?;
        let stats = publisher.handle(Action::Stats).await?;
        assert!(stats["video"]["packets"].as_u64().is_some());
        assert!(stats["audio"]["packets"].as_u64().is_some());
        packet[1] = 111;
        assert!(publisher.ingest_rtp(packet.clone()).is_err());
        packet[1] = 102;
        packet[0] = 0x90;
        assert!(publisher.ingest_rtp(packet).is_err());
        drop(publisher);
        assert_eq!(relay.feeds().len(), 1);
        drop(second);
        assert!(relay.feeds().is_empty());
        Ok(())
    }

    #[tokio::test]
    async fn routes_video_and_audio_with_owned_transports() -> Result<()> {
        let socket = UdpSocket::bind("127.0.0.1:0")?;
        let port = socket.local_addr()?.port();
        drop(socket);
        let relay = Relay::start(Config {
            publisher_key: "publisher-secret-that-is-long-enough".into(),
            viewer_key: "viewer-secret-that-is-also-long-enough".into(),
            signal: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 8788),
            rtc_ip: IpAddr::V4(Ipv4Addr::LOCALHOST),
            rtc_port: port,
            announced_address: None,
            max_headsets: 1,
            max_viewers: 1,
        })
        .await?;
        assert!(
            relay
                .join(Action::Join {
                    role: Role::Viewer,
                    key: "wrong".into(),
                    headset_id: None,
                })
                .is_err()
        );
        let (mut publisher, _) = relay.join(Action::Join {
            role: Role::Publisher,
            key: relay.config.publisher_key.clone(),
            headset_id: Some("quest-a".into()),
        })?;
        assert!(
            relay
                .join(Action::Join {
                    role: Role::Publisher,
                    key: relay.config.publisher_key.clone(),
                    headset_id: Some("quest-b".into()),
                })
                .is_err()
        );
        let (mut viewer, _) = relay.join(Action::Join {
            role: Role::Viewer,
            key: relay.config.viewer_key.clone(),
            headset_id: None,
        })?;
        assert!(
            viewer
                .handle(Action::CreateTransport {
                    direction: Direction::Send
                })
                .await
                .is_err()
        );

        let send = publisher
            .handle(Action::CreateTransport {
                direction: Direction::Send,
            })
            .await?;
        let send_id: TransportId = send["id"].as_str().expect("transport id").parse()?;
        assert!(
            viewer
                .handle(Action::CloseTransport {
                    transport_id: send_id
                })
                .await
                .is_err()
        );
        let capabilities = serde_json::to_value(relay.router.rtp_capabilities())?;
        for (kind, mime, ssrc) in [
            (MediaKind::Video, "video/H264", 11_111_111),
            (MediaKind::Audio, "audio/opus", 22_222_222),
        ] {
            let codec = capabilities["codecs"]
                .as_array()
                .expect("router codecs")
                .iter()
                .find(|codec| codec["mimeType"] == mime)
                .expect("configured codec");
            let parameters: RtpParameters = serde_json::from_value(json!({
                "codecs": [{
                    "mimeType": mime,
                    "payloadType": codec["preferredPayloadType"],
                    "clockRate": codec["clockRate"],
                    "channels": codec["channels"],
                    "parameters": codec["parameters"],
                    "rtcpFeedback": codec["rtcpFeedback"],
                }],
                "headerExtensions": [],
                "encodings": [{"ssrc": ssrc}],
                "rtcp": {"cname": "quest-a", "reducedSize": true},
            }))?;
            publisher
                .handle(Action::Produce {
                    transport_id: send_id,
                    kind,
                    rtp_parameters: parameters,
                })
                .await?;
        }
        let feeds = relay.feeds();
        assert_eq!(feeds.len(), 1);
        assert!(feeds[0].video.is_some() && feeds[0].audio.is_some());

        let recv = viewer
            .handle(Action::CreateTransport {
                direction: Direction::Recv,
            })
            .await?;
        let recv_id: TransportId = recv["id"].as_str().expect("transport id").parse()?;
        let client_capabilities: RtpCapabilities = serde_json::from_value(capabilities)?;
        for producer_id in [
            feeds[0].video.expect("video"),
            feeds[0].audio.expect("audio"),
        ] {
            let consumer = viewer
                .handle(Action::Consume {
                    transport_id: recv_id,
                    producer_id,
                    rtp_capabilities: client_capabilities.clone(),
                })
                .await?;
            let consumer_id: ConsumerId = consumer["id"].as_str().expect("consumer id").parse()?;
            viewer
                .handle(Action::ResumeConsumer { consumer_id })
                .await?;
        }
        publisher
            .handle(Action::CloseTransport {
                transport_id: send_id,
            })
            .await?;
        assert!(relay.feeds().is_empty());
        drop(publisher);
        assert!(
            relay
                .join(Action::Join {
                    role: Role::Publisher,
                    key: relay.config.publisher_key.clone(),
                    headset_id: Some("quest-a".into()),
                })
                .is_ok()
        );
        assert!(relay.feeds().is_empty());
        Ok(())
    }
}
