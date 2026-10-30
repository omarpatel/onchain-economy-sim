"use client";

import { useCallback, useState } from "react";
import type { Intent, IntentResult } from "@econ-sim/sim/protocol";
import { useWorld } from "../../lib/world.ts";
import { useUi } from "../../lib/store.ts";
import { sound, type Cue } from "../../lib/sound.ts";

export interface IntentForm {
  submit: (intent: Intent, okText: string, cue?: Cue) => Promise<IntentResult>;
  /** true from send until the server's result (or timeout) — disable the form */
  busy: boolean;
  /** the last rejection text from the server, cleared by the next successful submit */
  error: string | null;
}

/**
 * `send` wrapped with the shared feedback path: a toast for every result, a
 * cue on success, the error buzz on rejection, `busy` while the intent is in
 * flight and `error` with the server's rejection text for inline display.
 */
export function useIntent(): IntentForm {
  const { send } = useWorld();
  const toast = useUi((s) => s.toast);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = useCallback(async (intent: Intent, okText: string, cue: Cue = "fill") => {
    setBusy(true);
    try {
      const r = await send(intent);
      if (r.ok) { sound.play(cue); toast("ok", okText); setError(null); }
      else { const text = r.error ?? `${intent.kind} rejected`; sound.play("error"); toast("error", text); setError(text); }
      return r;
    } finally {
      setBusy(false);
    }
  }, [send, toast]);
  return { submit, busy, error };
}
