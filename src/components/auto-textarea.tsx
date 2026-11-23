"use client";

import { useLayoutEffect, useRef } from "react";

/**
 * A textarea that grows to show all of its text, so nothing is cut off at the bottom of a
 * fixed-height box (a draft's sign-off, a long rule on a phone). `rows` is the minimum height.
 */
export function AutoTextarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      el.style.height = "auto";
      // +2 for the top and bottom border, which scrollHeight leaves out.
      el.style.height = `${el.scrollHeight + 2}px`;
    };
    fit();
    // The text re-wraps when the column changes width (phone rotation, window resize).
    let width = el.offsetWidth;
    const observer = new ResizeObserver(() => {
      if (el.offsetWidth !== width) {
        width = el.offsetWidth;
        fit();
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [props.value]);
  return <textarea ref={ref} {...props} style={{ ...props.style, resize: "none", overflow: "hidden" }} />;
}
