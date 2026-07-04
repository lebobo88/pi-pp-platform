import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Modal } from "@/components/Modal";
import { Button } from "@/components/Button";
import { useAuthStore } from "@/stores/authStore";

/**
 * Non-dismissable auth prompt, mounted once near the root. When any request
 * 401s the client flags `unauthorized` and this modal takes over: the user
 * pastes the daemon's API token, Connect stores it (clearing the flag) and
 * refetches everything. A wrong token simply 401s again — the flag re-trips,
 * the modal reopens, and an inline error explains the rejection.
 */
export function TokenGate() {
  const qc = useQueryClient();
  const unauthorized = useAuthStore((s) => s.unauthorized);
  const setToken = useAuthStore((s) => s.setToken);

  const [value, setValue] = useState("");
  const [rejected, setRejected] = useState(false);
  // True once the user has attempted a Connect — used to distinguish the
  // first 401 (no error shown) from a re-trip after a bad token (error shown).
  const attemptedRef = useRef(false);

  useEffect(() => {
    if (unauthorized && attemptedRef.current) setRejected(true);
  }, [unauthorized]);

  const connect = () => {
    const token = value.trim();
    if (!token) return;
    attemptedRef.current = true;
    setRejected(false);
    setValue("");
    setToken(token); // also clears the unauthorized flag
    void qc.invalidateQueries();
  };

  if (!unauthorized) return null;

  return (
    <Modal
      open
      onClose={() => {}} // non-dismissable: token required to proceed
      title="API token required"
      width={400}
      footer={
        <Button variant="primary" onClick={connect} disabled={!value.trim()}>
          Connect
        </Button>
      }
    >
      <p className="text-[12px] leading-relaxed text-ink-2">
        The daemon rejected the request (401). Paste the harness API token to
        reconnect — it's stored locally and sent as a bearer header.
      </p>
      <input
        type="password"
        autoComplete="off"
        autoFocus
        data-testid="token-input"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") connect();
        }}
        placeholder="API token"
        className="mono mt-2 w-full rounded-sm border border-line-2 bg-bg-2 px-2 py-1.5 text-[12px] text-ink-1 outline-none focus:border-accent"
      />
      {rejected && (
        <div className="mt-2 text-[12px] text-fail" data-testid="token-rejected">
          Token rejected — the daemon returned 401 again. Check the token and retry.
        </div>
      )}
    </Modal>
  );
}
