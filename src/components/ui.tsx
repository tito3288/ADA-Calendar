"use client";
import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { useRef, type ReactNode } from "react";
import type { AppState, ScheduleProposal } from "@/lib/types";

export class ApiError extends Error {
  constructor(message: string, readonly proposal?: ScheduleProposal, readonly state?: AppState) { super(message); this.name = "ApiError"; }
}

export async function api<T = { state: AppState }>(
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(
    `/api/${path}`,
    body === undefined
      ? { cache: "no-store" }
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const result = await res.json();
  if (!res.ok)
    throw new ApiError(result.error || "This action could not be completed.", result.proposal, result.state);
  return result as T;
}
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  wide = false,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  wide?: boolean;
}) {
  const previousFocus = useRef<HTMLElement | null>(null);
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content
          className={`modal-content ${wide ? "modal-wide" : ""}`}
          aria-label={title}
          onOpenAutoFocus={() => {
            previousFocus.current =
              document.activeElement instanceof HTMLElement
                ? document.activeElement
                : null;
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (previousFocus.current?.isConnected)
              previousFocus.current.focus();
          }}
        >
          <div className="modal-heading">
            <div>
              <Dialog.Title>{title}</Dialog.Title>
              <Dialog.Description className={description ? "muted" : "sr-only"}>
                {description || "View and manage this workspace record."}
              </Dialog.Description>
            </div>
            <Dialog.Close className="icon-button" aria-label="Close dialog">
              <X size={20} />
            </Dialog.Close>
          </div>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label>
      {label}
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}
export function Empty({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty">
      <span className="empty-symbol">↗</span>
      <h3>{title}</h3>
      <p className="muted">{children}</p>
    </div>
  );
}
export function dateLabel(date: string, options?: Intl.DateTimeFormatOptions) {
  return new Intl.DateTimeFormat(
    "en-US",
    options ?? { month: "short", day: "numeric" },
  ).format(new Date(`${date}T12:00:00Z`));
}
export function timeLabel(instant: string, timeZone: string) {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  }).format(new Date(instant));
}
