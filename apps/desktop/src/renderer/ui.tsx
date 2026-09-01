import React from "react";

/**
 * The handful of shapes the interface repeats.
 *
 * Everything is Tailwind utilities; what gets reused is the *component*, not a
 * CSS class. A class like `.card` and a component called `Card` inevitably
 * drift apart, and then it is never clear which one owns a given rule. Here
 * there is only ever one answer.
 */

const FOCUS = "focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2";

const BUTTON_BASE = [
  "inline-flex items-center justify-center gap-2 rounded-md border px-4 py-2",
  "text-[15px] font-medium whitespace-nowrap cursor-pointer",
  "transition-colors motion-reduce:transition-none",
  "disabled:cursor-not-allowed disabled:opacity-40",
  FOCUS
].join(" ");

const TONES = {
  primary: "border-accent bg-accent-sunk text-accent enabled:hover:brightness-125",
  default: "border-rule bg-sunk text-ink enabled:hover:border-accent enabled:hover:text-accent",
  ghost: "border-transparent bg-transparent text-muted enabled:hover:text-accent"
} as const;

export function Button({
  tone = "default",
  small = false,
  className = "",
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  readonly tone?: keyof typeof TONES;
  readonly small?: boolean;
}): React.ReactElement {
  return (
    <button
      type="button"
      {...rest}
      className={`${BUTTON_BASE} ${TONES[tone]} ${small ? "px-2 py-1 text-[13px]" : ""} ${className}`}
    />
  );
}

const FIELD_BASE = [
  "w-full rounded-md border border-rule bg-sunk px-3 py-2",
  "text-ink placeholder:text-faint",
  "focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-1"
].join(" ");

export function Input({
  className = "",
  ...rest
}: React.InputHTMLAttributes<HTMLInputElement>): React.ReactElement {
  return <input {...rest} className={`${FIELD_BASE} ${className}`} />;
}

export function TextArea({
  className = "",
  ...rest
}: React.TextareaHTMLAttributes<HTMLTextAreaElement>): React.ReactElement {
  return <textarea {...rest} className={`${FIELD_BASE} resize-y font-mono text-xs ${className}`} />;
}

export function Card({
  className = "",
  children
}: {
  readonly className?: string;
  readonly children: React.ReactNode;
}): React.ReactElement {
  return (
    <section className={`grid gap-3 rounded-xl border border-rule bg-surface px-6 py-5 ${className}`}>
      {children}
    </section>
  );
}

/** A card that leads with a coloured edge, for the one thing on screen that matters. */
export function HeroCard({
  tone,
  children
}: {
  readonly tone: "good" | "attention" | "neutral";
  readonly children: React.ReactNode;
}): React.ReactElement {
  const edge =
    tone === "good" ? "border-l-accent" : tone === "attention" ? "border-l-warn" : "border-l-rule";
  return <Card className={`border-l-[3px] ${edge}`}>{children}</Card>;
}

export function Heading({ children }: { readonly children: React.ReactNode }): React.ReactElement {
  return <h2 className="m-0 text-[17px] font-semibold tracking-tight text-ink">{children}</h2>;
}

export function Body({ children }: { readonly children: React.ReactNode }): React.ReactElement {
  return <p className="m-0 text-muted">{children}</p>;
}

/** Secondary text: explanations, timestamps, the small print under a control. */
export function Sub({
  className = "",
  children
}: {
  readonly className?: string;
  readonly children: React.ReactNode;
}): React.ReactElement {
  return <p className={`m-0 text-[13.5px] text-faint ${className}`}>{children}</p>;
}

export function Row({
  className = "",
  children
}: {
  readonly className?: string;
  readonly children: React.ReactNode;
}): React.ReactElement {
  return <div className={`flex flex-wrap items-center gap-2 ${className}`}>{children}</div>;
}

/**
 * A numbered step.
 *
 * The number is an element rather than a CSS counter: a counter cannot be read
 * by a screen reader, and it silently renumbers when a step is added elsewhere.
 */
export function Step({
  number,
  title,
  children
}: {
  readonly number: number;
  readonly title: string;
  readonly children: React.ReactNode;
}): React.ReactElement {
  return (
    <li className="grid grid-cols-[1.6rem_1fr] items-start gap-3">
      <span
        aria-hidden="true"
        className="grid size-[1.6rem] place-items-center rounded-full border border-rule bg-sunk text-[13px] text-muted"
      >
        {number}
      </span>
      <div className="grid justify-items-start gap-2">
        <strong className="font-medium text-ink">{title}</strong>
        {children}
      </div>
    </li>
  );
}
