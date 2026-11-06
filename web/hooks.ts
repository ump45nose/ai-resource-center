import { useEffect, useState } from "react";

export function usePolling(poll: (first: boolean) => void, key?: unknown) {
  useEffect(() => {
    poll(true);
    const timer = setInterval(() => poll(false), 10000);
    return () => clearInterval(timer);
  }, [key]);
}

export function useVersionChange(version: number, onChange: () => void) {
  const [seen, setSeen] = useState(version);
  if (version !== seen) {
    setSeen(version);
    onChange();
  }
}
