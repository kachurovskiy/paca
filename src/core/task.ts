/** Give rendering, input and execution work a task turn without nested-timer delays. */
export function yieldTask(): Promise<void> {
  if (typeof window === 'undefined' || typeof MessageChannel === 'undefined') return new Promise(resolve => setTimeout(resolve, 0));
  return new Promise(resolve => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => { channel.port1.close(); channel.port2.close(); resolve(); };
    channel.port2.postMessage(null);
  });
}
