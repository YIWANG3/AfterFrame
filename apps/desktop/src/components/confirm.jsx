import { useEffect, useRef, useState } from "react";
import ConfirmDialog from "./ConfirmDialog";

/* ─── Global confirm() ────────────────────────────────────────
   Mount <ConfirmHost /> once near the app root. Then any module —
   component or not — can `await confirm({ title, message, ... })`
   and get back true (confirmed) / false (cancelled), without prop
   drilling or context. Mirrors window.confirm() but App-styled.

   Usage:
     import { confirm } from "./components/confirm";
     if (await confirm({ title, message, danger: true })) { ... }
*/

let request = null;

export function confirm(options) {
  if (!request) return Promise.resolve(false);
  return request(options);
}

export function ConfirmHost() {
  const [state, setState] = useState(null);
  const resolveRef = useRef(null);

  const settle = (result) => {
    setState(null);
    const resolve = resolveRef.current;
    resolveRef.current = null;
    resolve?.(result);
  };

  useEffect(() => {
    request = (options) =>
      new Promise((resolve) => {
        // A second request while one is open: resolve the stale one false.
        resolveRef.current?.(false);
        resolveRef.current = resolve;
        setState(options || {});
      });
    return () => { request = null; };
  }, []);

  return (
    <ConfirmDialog
      open={!!state}
      {...(state || {})}
      onConfirm={() => settle(true)}
      onCancel={() => settle(false)}
    />
  );
}
