import { useEffect } from "react";

export function usePolling(poll: (first: boolean) => void, key?: unknown) {
  useEffect(() => {
    poll(true);
    const timer = setInterval(() => poll(false), 10000);
    return () => clearInterval(timer);
  }, [key]);
}
