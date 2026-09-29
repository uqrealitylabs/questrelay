import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { Mascot } from "../api";

type Reaction =
  | "boop"
  | "heart"
  | "dance"
  | "blush"
  | "yawn"
  | "sparkle"
  | "peek"
  | "wave"
  | "bounce"
  | "sway"
  | "shimmy"
  | "twirl"
  | "groove"
  | "cheer"
  | "curious"
  | "sleep"
  | "startle"
  | "concern"
  | "relief"
  | "shush"
  | "clap"
  | "nod";
export type MascotSituation =
  | "waiting"
  | "connecting"
  | "live"
  | "muted"
  | "offline"
  | "error";
const effects: Partial<Record<Reaction, string>> = {
  heart: "♥",
  dance: "♪",
  blush: "♥",
  yawn: "z z",
  sparkle: "✦",
  peek: "?",
  bounce: "✦",
  sway: "♫",
  shimmy: "♪",
  twirl: "✦",
  groove: "♫",
  cheer: "✦",
  curious: "?",
  sleep: "z z",
  startle: "!",
  concern: "…",
  relief: "♥",
  shush: "♡",
  clap: "✦",
  nod: "♪",
};
const idle: Record<Mascot["mood"], Reaction[]> = {
  playful: [
    "dance",
    "bounce",
    "sway",
    "shimmy",
    "twirl",
    "groove",
    "wave",
    "clap",
    "sparkle",
    "peek",
    "heart",
    "curious",
  ],
  gentle: [
    "wave",
    "sway",
    "clap",
    "heart",
    "blush",
    "curious",
    "nod",
    "relief",
  ],
  sleepy: ["yawn", "sleep", "peek", "nod", "wave", "blush"],
};
const clicked: Record<Mascot["mood"], Reaction[]> = {
  playful: ["boop", ...idle.playful, "blush"],
  gentle: ["boop", ...idle.gentle, "cheer"],
  sleepy: ["boop", ...idle.sleepy, "heart"],
};
const situationCue: Record<MascotSituation, Reaction> = {
  waiting: "curious",
  connecting: "peek",
  live: "relief",
  muted: "shush",
  offline: "concern",
  error: "startle",
};
const screenIdle: Partial<Record<MascotSituation, Reaction[]>> = {
  waiting: ["curious", "wave", "yawn", "bounce"],
  connecting: ["peek", "curious", "nod"],
  muted: ["shush", "nod", "wave"],
  offline: ["concern", "peek", "curious"],
  error: ["concern", "peek"],
};
function pick(choices: Reaction[], previous: Reaction | null): Reaction {
  const fresh = choices.filter((choice) => choice !== previous);
  return fresh[Math.floor(Math.random() * fresh.length)] ?? choices[0];
}
const defaultMascot: Mascot = {
  name: "Mochi",
  mood: "playful",
  accessory: "leaf",
};

export function Capybara({
  className = "",
  home = false,
  mood = "idle",
  mascot = defaultMascot,
  situation,
  feedCount = 0,
}: {
  className?: string;
  home?: boolean;
  mood?: "idle" | "oops";
  mascot?: Mascot;
  situation?: MascotSituation;
  feedCount?: number;
}) {
  const navigate = useNavigate();
  const avatar = useRef<HTMLButtonElement>(null);
  const reactionTimer = useRef(0);
  const navigationTimer = useRef(0);
  const winkTimer = useRef(0);
  const lastWink = useRef(0);
  const lastReaction = useRef<Reaction | null>(null);
  const previousScreen = useRef({ situation, feedCount });
  const [reaction, setReaction] = useState<Reaction | null>(null);
  const [winking, setWinking] = useState(false);
  const [blinking, setBlinking] = useState(false);

  const canMove = useCallback(
    () =>
      !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches &&
      !avatar.current?.closest('[data-motion="quiet"]'),
    [],
  );
  const play = useCallback(
    (next: Reaction) => {
      if (document.visibilityState === "hidden" || !canMove()) return;
      lastReaction.current = next;
      setReaction(next);
      clearTimeout(reactionTimer.current);
      const duration = ["twirl", "shimmy", "groove", "sleep"].includes(next)
        ? 1750
        : 1250;
      reactionTimer.current = window.setTimeout(
        () => setReaction(null),
        duration,
      );
    },
    [canMove],
  );
  const wink = () => {
    if (!canMove() || Date.now() - lastWink.current < 1600) return;
    lastWink.current = Date.now();
    setWinking(true);
    clearTimeout(winkTimer.current);
    winkTimer.current = window.setTimeout(() => setWinking(false), 280);
  };

  useEffect(() => {
    let frame = 0;
    const look = (event: PointerEvent) => {
      if (event.pointerType === "touch" || !canMove()) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const element = avatar.current;
        if (!element) return;
        const rect = element.getBoundingClientRect();
        const dx = event.clientX - rect.left - rect.width / 2;
        const dy = event.clientY - rect.top - rect.height / 2;
        const distance = Math.max(1, Math.hypot(dx, dy));
        const strength = Math.min(
          1,
          distance / Math.max(100, rect.width * 1.6),
        );
        const eye = Math.max(1, rect.width / 100);
        element.style.setProperty(
          "--eye-x",
          `${(dx / distance) * strength * eye}px`,
        );
        element.style.setProperty(
          "--eye-y",
          `${(dy / distance) * strength * eye}px`,
        );
        element.style.setProperty(
          "--head-x",
          `${(dx / distance) * strength * eye * 0.55}px`,
        );
        element.style.setProperty(
          "--head-y",
          `${(dy / distance) * strength * eye * 0.4}px`,
        );
        element.style.setProperty(
          "--head-tilt",
          `${(dx / distance) * strength * 2}deg`,
        );
      });
    };
    const reset = () => {
      for (const name of [
        "--eye-x",
        "--eye-y",
        "--head-x",
        "--head-y",
        "--head-tilt",
      ])
        avatar.current?.style.removeProperty(name);
    };
    window.addEventListener("pointermove", look, { passive: true });
    document.addEventListener("pointerleave", reset);
    return () => {
      window.removeEventListener("pointermove", look);
      document.removeEventListener("pointerleave", reset);
      cancelAnimationFrame(frame);
      clearTimeout(reactionTimer.current);
      clearTimeout(navigationTimer.current);
      clearTimeout(winkTimer.current);
    };
  }, [canMove]);

  useEffect(() => {
    if (!canMove()) return;
    let timer = 0;
    let blinkTimer = 0;
    const blink = () => {
      if (document.visibilityState === "visible") {
        setBlinking(true);
        blinkTimer = window.setTimeout(() => setBlinking(false), 140);
      }
      timer = window.setTimeout(blink, 4500 + Math.random() * 5000);
    };
    timer = window.setTimeout(blink, 4500 + Math.random() * 5000);
    return () => {
      clearTimeout(timer);
      clearTimeout(blinkTimer);
    };
  }, [canMove]);

  useEffect(() => {
    let timer = 0;
    const surprise = () => {
      if (document.visibilityState === "visible" && canMove()) {
        play(
          pick(
            (situation && screenIdle[situation]) ||
              idle[mascot.mood] ||
              idle.playful,
            lastReaction.current,
          ),
        );
      }
      timer = window.setTimeout(surprise, 9500 + Math.random() * 8000);
    };
    timer = window.setTimeout(surprise, 7500 + Math.random() * 6500);
    return () => clearTimeout(timer);
  }, [mascot.mood, situation, canMove, play]);

  useEffect(() => {
    const previous = previousScreen.current;
    previousScreen.current = { situation, feedCount };
    if (feedCount > previous.feedCount) play("cheer");
    else if (feedCount < previous.feedCount) play("concern");
    else if (situation && situation !== previous.situation)
      play(situationCue[situation]);
  }, [situation, feedCount, play]);

  const surprise = () => {
    wink();
    play(pick(clicked[mascot.mood] ?? clicked.playful, lastReaction.current));
    if (home) {
      clearTimeout(navigationTimer.current);
      navigationTimer.current = window.setTimeout(
        () => navigate("/"),
        canMove() ? 450 : 0,
      );
    }
  };

  return (
    <button
      ref={avatar}
      type="button"
      onClick={surprise}
      onPointerEnter={wink}
      onFocus={wink}
      className={`capybara-avatar ${className} ${winking ? "winking" : ""} ${blinking ? "blinking" : ""} ${mood === "oops" ? "capybara-oops" : ""} ${reaction ? `cap-${reaction}` : ""} cap-mood-${mascot.mood} ${situation ? `cap-situation-${situation}` : ""}`}
      aria-label={home ? "QuestRelay home" : `Give ${mascot.name} a surprise`}
      title={home ? "QuestRelay home" : `Say hello to ${mascot.name}`}
    >
      {reaction && effects[reaction] && (
        <span
          className={`cap-effect cap-effect-${reaction}`}
          aria-hidden="true"
        >
          {effects[reaction]}
        </span>
      )}
      <span className="capybara-face">
        <img src="/capybara.svg" alt="" draggable={false} />
        <span className="cap-brow cap-brow-left" />
        <span className="cap-brow cap-brow-right" />
        <span className="cap-eye cap-eye-left">
          <i />
        </span>
        <span className="cap-eye cap-eye-right">
          <i />
        </span>
        <span className="cap-cheek cap-cheek-left" />
        <span className="cap-cheek cap-cheek-right" />
        <svg className="cap-mouth" viewBox="0 0 64 48" aria-hidden="true">
          <path
            className="cap-mouth-soft"
            d="M32 1v15m0 0c-6 9-16 10-23 1m23-1c6 9 16 10 23 1"
          />
          <path className="cap-mouth-smile" d="M32 1v12M9 17c8 24 38 24 46 0" />
          <ellipse className="cap-mouth-open" cx="32" cy="25" rx="10" ry="14" />
          <path
            className="cap-mouth-worried"
            d="M32 1v14M13 32c9-10 29-10 38 0"
          />
          <path className="cap-mouth-sleep" d="M16 22c9 5 23 5 32 0" />
        </svg>
        <svg className="cap-limbs" viewBox="0 0 360 360" aria-hidden="true">
          <path
            className="cap-arm-left"
            d="M103 243c6 23 18 42 39 53 8 4 16 1 18-5 2-6-3-12-10-16-14-8-24-21-30-39"
          />
          <path
            className="cap-arm-right"
            d="M257 243c-6 23-18 42-39 53-8 4-16 1-18-5-2-6 3-12 10-16 14-8 24-21 30-39"
          />
        </svg>
        <span
          className={`cap-accessory accessory-${mascot.accessory}`}
          aria-hidden="true"
        >
          <i />
          <b />
        </span>
      </span>
    </button>
  );
}
