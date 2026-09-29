import { useEffect, useRef } from "react";

type Props = {
  deviceId: string;
  label: string;
};

/**
 * View-only H.264 player: WebSocket binary frames → WebCodecs VideoDecoder → canvas.
 */
export function StreamPlayer({ deviceId, label }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const protocol = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(
      `${protocol}://${location.host}/ws/stream/${encodeURIComponent(deviceId)}`,
    );
    ws.binaryType = "arraybuffer";

    let decoder: VideoDecoder | null = null;
    let configured = false;
    const annexB: number[] = [];

    const flushNalUnits = (bytes: Uint8Array) => {
      for (const b of bytes) annexB.push(b);
      // Keep a rolling buffer; feed decoder when we see IDR/slice NALs
      if (annexB.length < 8) return;

      if (!decoder) {
        if (typeof VideoDecoder === "undefined") return;
        decoder = new VideoDecoder({
          output: (frame) => {
            if (canvas.width !== frame.displayWidth) {
              canvas.width = frame.displayWidth;
              canvas.height = frame.displayHeight;
            }
            ctx.drawImage(frame, 0, 0);
            frame.close();
          },
          error: (err) => console.error("VideoDecoder error", err),
        });
      }

      if (!configured && decoder) {
        // Minimal AVC config; browsers often accept Annex-B via description omission
        // when using avc1 with in-band SPS/PPS (Chrome). Fallback: try configure once.
        try {
          decoder.configure({
            codec: "avc1.64001F",
            optimizeForLatency: true,
          });
          configured = true;
        } catch (err) {
          console.error(err);
          return;
        }
      }

      if (!configured || !decoder || decoder.state !== "configured") return;

      const chunk = new EncodedVideoChunk({
        type: "key",
        timestamp: performance.now() * 1000,
        data: new Uint8Array(annexB),
      });
      try {
        decoder.decode(chunk);
        annexB.length = 0;
      } catch {
        // wait for more SPS/PPS
      }
    };

    ws.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) {
        flushNalUnits(new Uint8Array(ev.data));
      }
    };

    return () => {
      ws.close();
      try {
        decoder?.close();
      } catch {
        // ignore
      }
    };
  }, [deviceId]);

  return (
    <div className="tile" data-testid={`stream-${deviceId}`}>
      <canvas ref={canvasRef} />
      <div className="tile-label">{label}</div>
    </div>
  );
}
