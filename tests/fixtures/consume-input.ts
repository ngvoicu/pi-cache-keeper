// A second extension, loaded after pi-cache-keeper, that answers one input by itself: Pi raises `input`, which reaches
// pi-cache-keeper first, and this one then handles it, so no request is sent and no answer comes.
export default function consume(pi: { on: (event: string, handler: (event: { text: string }) => unknown) => void }) {
	pi.on("input", (event) => (event.text === "handle locally" ? { action: "handled" } : undefined));
}
