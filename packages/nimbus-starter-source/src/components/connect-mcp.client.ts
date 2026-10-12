import { mount } from "@cloudflare/nimbus-docs/client";

const RESET_MS = 1500;

function initConnectMcp(root: HTMLElement): () => void {
  const open = root.querySelector<HTMLButtonElement>("[data-nb-connect-mcp-open]");
  const dialog = root.querySelector<HTMLDialogElement>("dialog");
  if (!open || !dialog) return () => {};

  const onOpen = () => dialog.showModal();
  open.addEventListener("click", onOpen);

  const timers = new Map<HTMLButtonElement, number>();
  const copies = [...root.querySelectorAll<HTMLButtonElement>("[data-nb-connect-mcp-copy]")];
  const handlers = copies.map((button) => {
    const idle = button.querySelector<HTMLElement>("[data-nb-connect-mcp-idle]");
    const done = button.querySelector<HTMLElement>("[data-nb-connect-mcp-done]");
    const show = (copied: boolean) => {
      if (idle) idle.hidden = copied;
      if (done) done.hidden = !copied;
    };
    const handler = async () => {
      try {
        await navigator.clipboard.writeText(button.dataset.copy ?? "");
      } catch {
        // Clipboard unavailable (insecure context) or permission denied.
        return;
      }
      show(true);
      const pending = timers.get(button);
      if (pending) window.clearTimeout(pending);
      timers.set(button, window.setTimeout(() => show(false), RESET_MS));
    };
    button.addEventListener("click", handler);
    return handler;
  });

  return () => {
    open.removeEventListener("click", onOpen);
    copies.forEach((button, index) => button.removeEventListener("click", handlers[index]!));
    for (const timer of timers.values()) window.clearTimeout(timer);
  };
}

mount("[data-nb-connect-mcp]", initConnectMcp);
