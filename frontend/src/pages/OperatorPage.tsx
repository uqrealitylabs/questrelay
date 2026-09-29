import {
  type DeviceInfo,
  type DeviceSettings,
  defaultDeviceSettings,
} from "@questrelay/shared";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";

export function OperatorPage() {
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pair, setPair] = useState({ host: "", port: "37100", code: "" });
  const [manual, setManual] = useState({ host: "", port: "5555" });
  const [editing, setEditing] = useState<Record<string, DeviceSettings>>({});

  const refresh = useCallback(async () => {
    const list = await api.listDevices();
    setDevices(list);
    setEditing((prev) => {
      const next = { ...prev };
      for (const d of list) {
        if (!next[d.id]) next[d.id] = { ...d.settings };
      }
      return next;
    });
  }, []);

  useEffect(() => {
    refresh().catch((err) => setMessage(err.message));
    const id = setInterval(() => {
      refresh().catch(() => undefined);
    }, 5000);
    return () => clearInterval(id);
  }, [refresh]);

  const run = async (
    key: string,
    fn: () => Promise<string> | Promise<void>,
  ) => {
    setBusy(key);
    setMessage(null);
    try {
      const successMessage = await fn();
      await refresh();
      if (successMessage) setMessage(successMessage);
    } catch (err) {
      setMessage((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="shell">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h1 className="brand">Operator</h1>
        <Link className="nav-link" to="/">
          Audience view
        </Link>
      </div>
      <p className="sub">
        Discover Quests, pair wireless debugging, start up to two view-only
        streams.
      </p>

      {message && (
        <p data-testid="operator-message" style={{ color: "var(--warn)" }}>
          {message}
        </p>
      )}

      <section className="panel">
        <h2>Devices</h2>
        <div className="row" style={{ marginBottom: "0.75rem" }}>
          <button
            type="button"
            className="primary"
            disabled={busy !== null}
            onClick={() => run("scan", refresh)}
          >
            Scan now
          </button>
          <button
            type="button"
            className="danger"
            disabled={busy !== null}
            onClick={() => {
              if (
                !confirm(
                  "Clear cached devices? This deletes backend/data/devices.json and resets saved favorites",
                )
              ) {
                return;
              }
              void run("clear", async () => {
                await api.clearCache();
                return "Device cache cleared.";
              });
            }}
          >
            Clear cached devices
          </button>
        </div>

        <table className="table">
          <thead>
            <tr>
              <th>Device</th>
              <th>Presence</th>
              <th>Settings</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {devices.map((d) => {
              const settings = editing[d.id] ?? d.settings;
              const isUsb = d.presence.includes("usb") && d.port === 0;
              return (
                <tr key={d.id} data-testid={`device-row-${d.id}`}>
                  <td>
                    <strong>{settings.label}</strong>
                    <div style={{ color: "var(--muted)", fontSize: "0.85rem" }}>
                      {d.id}
                      {d.state ? ` · ${d.state}` : ""}
                      {d.streaming ? " · streaming" : ""}
                    </div>
                  </td>
                  <td>
                    {d.presence.map((p) => (
                      <span className="badge" key={p}>
                        {p}
                      </span>
                    ))}
                  </td>
                  <td>
                    <div className="form-grid">
                      <input
                        aria-label={`Label ${d.id}`}
                        value={settings.label}
                        onChange={(e) =>
                          setEditing((prev) => ({
                            ...prev,
                            [d.id]: { ...settings, label: e.target.value },
                          }))
                        }
                      />
                      <input
                        aria-label={`Crop ${d.id}`}
                        value={settings.crop}
                        onChange={(e) =>
                          setEditing((prev) => ({
                            ...prev,
                            [d.id]: { ...settings, crop: e.target.value },
                          }))
                        }
                        placeholder="crop W:H:X:Y"
                      />
                      <input
                        aria-label={`Angle ${d.id}`}
                        type="number"
                        value={settings.angle}
                        onChange={(e) =>
                          setEditing((prev) => ({
                            ...prev,
                            [d.id]: {
                              ...settings,
                              angle: Number(e.target.value),
                            },
                          }))
                        }
                      />
                      <input
                        aria-label={`Bitrate ${d.id}`}
                        type="number"
                        value={settings.bitRate}
                        onChange={(e) =>
                          setEditing((prev) => ({
                            ...prev,
                            [d.id]: {
                              ...settings,
                              bitRate: Number(e.target.value),
                            },
                          }))
                        }
                      />
                      <input
                        aria-label={`FPS ${d.id}`}
                        type="number"
                        value={settings.maxFps}
                        onChange={(e) =>
                          setEditing((prev) => ({
                            ...prev,
                            [d.id]: {
                              ...settings,
                              maxFps: Number(e.target.value),
                            },
                          }))
                        }
                      />
                    </div>
                  </td>
                  <td>
                    <div className="row">
                      <button
                        type="button"
                        disabled={busy !== null || isUsb}
                        onClick={() =>
                          run(`save-${d.id}`, async () => {
                            await api.saveDevice(d.id, {
                              host:
                                d.host === "usb"
                                  ? manual.host || d.host
                                  : d.host,
                              port: d.port || 5555,
                              serial: d.serial,
                              settings: defaultDeviceSettings(settings),
                            });
                            return `Saved ${settings.label}`;
                          })
                        }
                      >
                        Save
                      </button>
                      {!d.streaming ? (
                        <button
                          type="button"
                          className="primary"
                          disabled={busy !== null || isUsb}
                          onClick={() =>
                            run(`start-${d.id}`, async () => {
                              await api.saveDevice(d.id, {
                                host: d.host,
                                port: d.port,
                                serial: d.serial ?? d.id,
                                settings: defaultDeviceSettings(settings),
                              });
                              await api.startStream(d.id, d.serial ?? d.id);
                              return `Starting ${settings.label} — accept "Allow USB debugging?" on the headset if prompted.`;
                            })
                          }
                        >
                          Start stream
                        </button>
                      ) : (
                        <button
                          type="button"
                          disabled={busy !== null}
                          onClick={() =>
                            run(`stop-${d.id}`, async () => {
                              await api.stopStream(d.id);
                            })
                          }
                        >
                          Stop
                        </button>
                      )}
                      {isUsb && (
                        <button
                          type="button"
                          disabled={busy !== null}
                          onClick={() =>
                            run(`wifi-${d.id}`, async () => {
                              const result = await api.enableWireless(
                                d.serial ?? d.id,
                              );
                              return result.ok
                                ? `Wireless ADB enabled at ${result.host}:${result.port}`
                                : (result.message ?? "Failed");
                            })
                          }
                        >
                          Enable wireless ADB
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <section className="panel">
        <h2>Wireless debugging pair</h2>
        <div className="form-grid">
          <input
            placeholder="Headset IP"
            value={pair.host}
            onChange={(e) => setPair({ ...pair, host: e.target.value })}
          />
          <input
            placeholder="Pairing port"
            value={pair.port}
            onChange={(e) => setPair({ ...pair, port: e.target.value })}
          />
          <input
            placeholder="Pairing code"
            value={pair.code}
            onChange={(e) => setPair({ ...pair, code: e.target.value })}
          />
        </div>
        <div className="row" style={{ marginTop: "0.75rem" }}>
          <button
            type="button"
            className="primary"
            disabled={busy !== null}
            onClick={() =>
              run("pair", async () => {
                const result = await api.pair(
                  pair.host,
                  Number(pair.port),
                  pair.code,
                );
                return result.message;
              })
            }
          >
            Pair
          </button>
        </div>
      </section>

      <section className="panel">
        <h2>Manual connect</h2>
        <div className="form-grid">
          <input
            placeholder="Host IP"
            value={manual.host}
            onChange={(e) => setManual({ ...manual, host: e.target.value })}
          />
          <input
            placeholder="ADB port"
            value={manual.port}
            onChange={(e) => setManual({ ...manual, port: e.target.value })}
          />
        </div>
        <div className="row" style={{ marginTop: "0.75rem" }}>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() =>
              run("connect", async () => {
                const result = await api.connect(
                  manual.host,
                  Number(manual.port),
                );
                return result.message;
              })
            }
          >
            Connect
          </button>
        </div>
      </section>
    </div>
  );
}
