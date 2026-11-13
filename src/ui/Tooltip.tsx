/**
 * One tooltip for the whole app: any element with a ``data-tip`` attribute shows that text
 * after a short hover, or when it gets keyboard focus. Faster and steadier than the browser's
 * own ``title`` tooltips, and styled like the rest of the app.
 */
import { useEffect, useRef, useState } from "react";

const DELAY_MS = 350;

export function Tooltip() {
  const [tip, setTip] = useState<{ text: string; x: number; y: number; below: boolean } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const current = useRef<Element | null>(null);

  useEffect(() => {
    const show = (el: Element) => {
      const text = el.getAttribute("data-tip");
      if (!text) return;
      const r = el.getBoundingClientRect();
      const below = r.top < 90;
      setTip({ text, x: r.left + r.width / 2, y: below ? r.bottom + 8 : r.top - 8, below });
    };
    const hide = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      current.current = null;
      setTip(null);
    };
    const onOver = (e: Event) => {
      const el = (e.target as Element | null)?.closest?.("[data-tip]") ?? null;
      if (el === current.current) return;
      hide();
      if (!el) return;
      // Focus shows the tip only for keyboard focus, not after a click.
      if (e.type === "focusin" && !el.matches(":focus-visible")) return;
      current.current = el;
      timer.current = setTimeout(() => show(el), e.type === "focusin" ? 0 : DELAY_MS);
    };
    document.addEventListener("mouseover", onOver);
    document.addEventListener("focusin", onOver);
    document.addEventListener("focusout", hide);
    document.addEventListener("pointerdown", hide);
    document.addEventListener("scroll", hide, true);
    window.addEventListener("blur", hide);
    return () => {
      document.removeEventListener("mouseover", onOver);
      document.removeEventListener("focusin", onOver);
      document.removeEventListener("focusout", hide);
      document.removeEventListener("pointerdown", hide);
      document.removeEventListener("scroll", hide, true);
      window.removeEventListener("blur", hide);
    };
  }, []);

  if (!tip) return null;
  const width = 280;
  const left = Math.max(8, Math.min(window.innerWidth - width - 8, tip.x - width / 2));
  return (
    <div
      role="tooltip"
      className="tooltip"
      style={{
        left,
        maxWidth: width,
        top: tip.below ? tip.y : undefined,
        bottom: tip.below ? undefined : window.innerHeight - tip.y,
      }}
    >
      {tip.text}
    </div>
  );
}
