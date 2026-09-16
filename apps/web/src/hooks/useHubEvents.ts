import { useEffect, useRef } from 'react';

export interface HubEventPayload {
  type: 'usage-updated' | 'agents-updated' | 'memory-synced' | 'collect-started' | 'collect-finished';
  at: string;
  data?: { inserted?: number; parsed?: number; added?: string[] };
}

/**
 * Subscribe to the hub's SSE stream. `onEvent` fires for every hub event;
 * `onUsageUpdated` is a convenience for the common "reload my data" case.
 * Auto-reconnects with backoff (EventSource handles that natively).
 */
export function useHubEvents(handlers: {
  onEvent?: (event: HubEventPayload) => void;
  onUsageUpdated?: () => void;
  onAgentsUpdated?: () => void;
}): void {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    const source = new EventSource('/api/events');

    const onUsage = () => handlersRef.current.onUsageUpdated?.();
    const onAgents = () => handlersRef.current.onAgentsUpdated?.();
    const onAny = (raw: MessageEvent) => {
      try {
        const event = JSON.parse(raw.data as string) as HubEventPayload;
        handlersRef.current.onEvent?.(event);
      } catch {
        // non-JSON frame (ping/hello) — ignore
      }
    };

    source.addEventListener('usage-updated', onUsage);
    source.addEventListener('agents-updated', onAgents);
    source.addEventListener('memory-synced', onAny);
    source.addEventListener('collect-started', onAny);
    source.addEventListener('collect-finished', onAny);

    return () => source.close();
  }, []);
}
