use anyhow::{Context, Result, ensure};
use std::net::{IpAddr, Ipv4Addr, SocketAddr};

pub struct Config {
    pub publisher_key: String,
    pub viewer_key: String,
    pub signal: SocketAddr,
    pub rtc_ip: IpAddr,
    pub rtc_port: u16,
    pub announced_address: Option<String>,
    pub max_headsets: usize,
    pub max_viewers: usize,
    pub egress_budget_bps: u32,
}

impl Config {
    pub fn from_env() -> Result<Self> {
        Self::read(|name| std::env::var(name).ok())
    }

    fn read(get: impl Fn(&str) -> Option<String>) -> Result<Self> {
        let publisher_key =
            get("QUESTRELAY_PUBLISH_KEY").context("QUESTRELAY_PUBLISH_KEY required")?;
        let viewer_key = get("QUESTRELAY_VIEW_KEY").context("QUESTRELAY_VIEW_KEY required")?;
        ensure!(
            publisher_key.len() >= 32 && viewer_key.len() >= 32 && publisher_key != viewer_key,
            "Configure distinct publisher and viewer keys of at least 32 bytes"
        );

        let signal_ip = get("QUESTRELAY_SIGNAL_HOST")
            .unwrap_or_else(|| Ipv4Addr::LOCALHOST.to_string())
            .parse::<IpAddr>()
            .context("QUESTRELAY_SIGNAL_HOST must be an IP address")?;
        let rtc_ip = get("QUESTRELAY_RTC_LISTEN_IP")
            .unwrap_or_else(|| Ipv4Addr::LOCALHOST.to_string())
            .parse::<IpAddr>()
            .context("QUESTRELAY_RTC_LISTEN_IP must be an IP address")?;
        let announced_address =
            get("QUESTRELAY_RTC_ANNOUNCED_ADDRESS").filter(|value| !value.is_empty());
        ensure!(
            !rtc_ip.is_unspecified() || announced_address.is_some(),
            "QUESTRELAY_RTC_ANNOUNCED_ADDRESS required for a wildcard RTC bind"
        );

        Ok(Self {
            publisher_key,
            viewer_key,
            signal: SocketAddr::new(signal_ip, number(&get, "QUESTRELAY_SIGNAL_PORT", 8788)?),
            rtc_ip,
            rtc_port: number(&get, "QUESTRELAY_RTC_PORT", 44444)?,
            announced_address,
            max_headsets: number(&get, "QUESTRELAY_MAX_HEADSETS", 8)? as usize,
            max_viewers: number(&get, "QUESTRELAY_MAX_VIEWERS", 64)? as usize,
            egress_budget_bps: get("QUESTRELAY_EGRESS_BUDGET_MBPS")
                .unwrap_or_else(|| "200".into())
                .parse::<u32>()
                .context("QUESTRELAY_EGRESS_BUDGET_MBPS must be a positive integer")?
                .checked_mul(1_000_000)
                .filter(|budget| *budget > 0)
                .context("QUESTRELAY_EGRESS_BUDGET_MBPS must be between 1 and 4294")?,
        })
    }
}

fn number(get: &impl Fn(&str) -> Option<String>, name: &str, default: u16) -> Result<u16> {
    match get(name) {
        Some(value) => {
            let parsed = value
                .parse::<u16>()
                .with_context(|| format!("{name} must be an integer from 1 to 65535"))?;
            ensure!(parsed > 0, "{name} must be an integer from 1 to 65535");
            Ok(parsed)
        }
        None => Ok(default),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requires_safe_keys_and_announced_address() {
        assert!(
            Config::read(|name| match name {
                "QUESTRELAY_PUBLISH_KEY" | "QUESTRELAY_VIEW_KEY" =>
                    Some("same-key-value-that-is-long-enough".into()),
                _ => None,
            })
            .is_err()
        );
        let values = |name: &str| match name {
            "QUESTRELAY_PUBLISH_KEY" => Some("p".repeat(32)),
            "QUESTRELAY_VIEW_KEY" => Some("v".repeat(32)),
            "QUESTRELAY_RTC_LISTEN_IP" => Some("0.0.0.0".into()),
            _ => None,
        };
        assert!(Config::read(|name| values(name)).is_err());
        let config = Config::read(|name| {
            if name == "QUESTRELAY_RTC_ANNOUNCED_ADDRESS" {
                Some("relay.example.test".into())
            } else {
                values(name)
            }
        });
        assert!(config.is_ok());
        assert_eq!(config.expect("valid config").max_headsets, 8);
    }
}
