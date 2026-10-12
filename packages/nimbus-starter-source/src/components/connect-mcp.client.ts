import { mount } from "@cloudflare/nimbus-docs/client";

const RESET_MS = 1500;

function initConnectMcp(root: HTMLElement): () => void {
  const open = root.querySelector<HTMLButtonElement>("[data-nb-connect-mcp-open]");
  const dialog = root.querySelector<HTMLDialogElement>("dialog");
  if (!open || !dialog) return () => {};

  const onOpen = () => dialog.showModal();
  open.addEventListener("click", onOpen);

  const status = root.querySelector<HTMLElement>("[data-nb-connect-mcp-status]");
  const timers = new Set<number>();
  const copies = [...root.querySelectorAll<HTMLButtonElement>("[data-nb-connect-mcp-copy]")];
  const handlers = copies.map((button) => {
    const label = button.querySelector<HTMLElement>("[data-nb-connect-mcp-label]");
    const idle = label?.textContent ?? "";
    let timer: number | undefined;
    const handler = async () => {
      let copied = true;
      try {
        await navigator.clipboard.writeText(button.dataset.copy ?? "");
      } catch {
        copied = false;
      }
      const message = copied ? "Copied" : "Couldn't copy";
      if (label) label.textContent = message;
      if (status) status.textContent = message;
      if (timer) {
        window.clearTimeout(timer);
        timers.delete(timer);
      }
      timer = window.setTimeout(() => {
        if (label) label.textContent = idle;
        if (status) status.textContent = "";
      }, RESET_MS);
      timers.add(timer);
    };
    button.addEventListener("click", handler);
    return handler;
  });

  return () => {
    open.removeEventListener("click", onOpen);
    copies.forEach((button, index) => button.removeEventListener("click", handlers[index]!));
    for (const timer of timers) window.clearTimeout(timer);
  };
}

mount("[data-nb-connect-mcp]", initConnectMcp);
