import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { Mascot } from "../api";

type Reaction = "boop" | "heart" | "dance" | "blush" | "yawn" | "sparkle" | "peek";
const effects: Record<Reaction, string> = {
  boop: "", heart: "♥", dance: "♪", blush: "♥", yawn: "z z", sparkle: "✦", peek: "?",
};
const defaultMascot: Mascot = { name: "Mochi", mood: "playful", accessory: "leaf" };

export function Capybara({ className = "", home = false, mood = "idle", mascot = defaultMascot }: {
  className?: string;
  home?: boolean;
  mood?: "idle" | "oops";
  mascot?: Mascot;
}) {
  const navigate = useNavigate();
  const avatar = useRef<HTMLButtonElement>(null);
  const reactionTimer = useRef(0);
  const navigationTimer = useRef(0);
  const winkTimer = useRef(0);
  const lastWink = useRef(0);
  const lastReaction = useRef<Reaction | null>(null);
  const [reaction, setReaction] = useState<Reaction | null>(null);
  const [winking, setWinking] = useState(false);
  const [blinking, setBlinking] = useState(false);

  const canMove = useCallback(() => !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches &&
    !avatar.current?.closest('[data-motion="quiet"]'), []);
  const play = useCallback((next: Reaction) => {
    if (!canMove()) return;
    lastReaction.current = next;
    setReaction(next);
    clearTimeout(reactionTimer.current);
    reactionTimer.current = window.setTimeout(() => setReaction(null), 1150);
  }, [canMove]);
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
        const strength = Math.min(1, distance / Math.max(100, rect.width * 1.6));
        const eye = Math.max(1, rect.width / 100);
        element.style.setProperty("--eye-x", `${dx / distance * strength * eye}px`);
        element.style.setProperty("--eye-y", `${dy / distance * strength * eye}px`);
        element.style.setProperty("--head-x", `${dx / distance * strength * eye * .55}px`);
        element.style.setProperty("--head-y", `${dy / distance * strength * eye * .4}px`);
        element.style.setProperty("--head-tilt", `${dx / distance * strength * 2}deg`);
      });
    };
    const reset = () => {
      for (const name of ["--eye-x", "--eye-y", "--head-x", "--head-y", "--head-tilt"])
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
    return () => { clearTimeout(timer); clearTimeout(blinkTimer); };
  }, [canMove]);

  useEffect(() => {
    const moods: Record<Mascot["mood"], Reaction[]> = {
      playful: ["dance", "sparkle", "peek", "heart", "blush"],
      gentle: ["heart", "blush", "peek"],
      sleepy: ["yawn", "peek", "blush"],
    };
    let timer = 0;
    const surprise = () => {
      if (document.visibilityState === "visible" && canMove()) {
        const choices = moods[mascot.mood] ?? moods.playful;
        const candidates = choices.filter((choice) => choice !== lastReaction.current);
        play(candidates[Math.floor(Math.random() * candidates.length)] ?? choices[0]);
      }
      timer = window.setTimeout(surprise, 14000 + Math.random() * 11000);
    };
    timer = window.setTimeout(surprise, 10000 + Math.random() * 9000);
    return () => clearTimeout(timer);
  }, [mascot.mood, canMove, play]);

  const surprise = () => {
    wink();
    const choices: Reaction[] = mascot.mood === "sleepy"
      ? ["yawn", "peek", "heart", "boop"]
      : ["boop", "heart", "dance", "blush", "sparkle", "peek"];
    const candidates = choices.filter((choice) => choice !== lastReaction.current);
    play(candidates[Math.floor(Math.random() * candidates.length)] ?? choices[0]);
    if (home) {
      clearTimeout(navigationTimer.current);
      navigationTimer.current = window.setTimeout(() => navigate("/"), canMove() ? 450 : 0);
    }
  };

  return <button ref={avatar} type="button" onClick={surprise} onPointerEnter={wink} onFocus={wink}
    className={`capybara-avatar ${className} ${winking ? "winking" : ""} ${blinking ? "blinking" : ""} ${mood === "oops" ? "capybara-oops" : ""} ${reaction ? `cap-${reaction}` : ""} cap-mood-${mascot.mood}`}
    aria-label={home ? "QuestRelay home" : `Give ${mascot.name} a surprise`}
    title={home ? "QuestRelay home" : `Say hello to ${mascot.name}`}>
    {reaction && effects[reaction] && <span className={`cap-effect cap-effect-${reaction}`} aria-hidden="true">{effects[reaction]}</span>}
    <span className="capybara-face">
      <img src="/capybara.svg" alt="" draggable={false} />
      <span className="cap-eye cap-eye-left"><i /></span>
      <span className="cap-eye cap-eye-right"><i /></span>
      <span className="cap-cheek cap-cheek-left" />
      <span className="cap-cheek cap-cheek-right" />
      <span className="cap-mouth" />
      <span className={`cap-accessory accessory-${mascot.accessory}`} aria-hidden="true"><i /><b /></span>
    </span>
  </button>;
}
