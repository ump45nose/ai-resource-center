import {
  useEffect,
  useId,
  useRef,
  useSyncExternalStore,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";
import { ArrowRight, Check, Search, X, type LucideIcon } from "lucide-react";
import type { Tone } from "./data";

// A modal dialog makes the rest of the page inert, so the toast renders
// inside the topmost open Overlay.
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};
const openDialogs: string[] = [];
const topDialog = () => openDialogs.at(-1) ?? null;
let toastText = "";
let toastTimer: ReturnType<typeof setTimeout> | undefined;
const currentToast = () => toastText;
export function showToast(text: string) {
  toastText = text;
  clearTimeout(toastTimer);
  if (text) toastTimer = setTimeout(() => showToast(""), 5000);
  emit();
}
export function ToastRegion({ owner = null }: { owner?: string | null }) {
  const text = useSyncExternalStore(subscribe, currentToast);
  const active = useSyncExternalStore(subscribe, topDialog) === owner;
  return (
    <div role="status">
      {active && text && (
        <div className="toast">
          <Check size={16} />
          <span>{text}</span>
          <button aria-label="关闭提示" onClick={() => showToast("")}>
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  );
}

export function Button({
  children,
  variant = "default",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "default" | "primary" | "ghost";
}) {
  return (
    <button
      type="button"
      className={`button ${variant} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}
export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: Tone;
}) {
  return <span className={`badge ${tone}`}>{children}</span>;
}
export function SectionHeading({
  title,
  meta,
  action,
}: {
  title: string;
  meta?: string;
  action?: ReactNode;
}) {
  return (
    <div className="section-heading">
      <div>
        <h2>{title}</h2>
        {meta && <span>{meta}</span>}
      </div>
      {action}
    </div>
  );
}
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  onAction,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  action?: string;
  onAction?: () => void;
}) {
  return (
    <div className="empty-state">
      <div className="empty-symbol">
        <Icon size={25} strokeWidth={1.3} />
      </div>
      <h2>{title}</h2>
      <p>{description}</p>
      {action && (
        <Button variant="primary" onClick={onAction}>
          {action}
          <ArrowRight size={15} />
        </Button>
      )}
    </div>
  );
}
export function FilterSearch({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  return (
    <label className="filter-search">
      <Search size={16} />
      <input
        className="filter-search-input"
        aria-label={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
      {value && (
        <button aria-label="清空搜索" onClick={() => onChange("")}>
          <X size={14} />
        </button>
      )}
    </label>
  );
}
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
}: {
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: string }[];
  label: string;
}) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          aria-pressed={value === option.value}
          className={value === option.value ? "active" : ""}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
export function Overlay({
  title,
  subtitle,
  children,
  onClose,
  drawer = false,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  onClose: () => void;
  drawer?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    document.body.style.overflow = "hidden";
    openDialogs.push(id);
    emit();
    return () => {
      dialog.close();
      openDialogs.splice(openDialogs.indexOf(id), 1);
      emit();
      if (!openDialogs.length) document.body.style.overflow = "";
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={drawer ? "overlay drawer" : "overlay"}
      aria-labelledby="overlay-title"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="overlay-panel">
        <header className="overlay-header">
          <div>
            {subtitle && <div className="eyebrow">{subtitle}</div>}
            <h2 id="overlay-title">{title}</h2>
          </div>
          <Button
            variant="ghost"
            className="icon-button"
            aria-label="关闭面板"
            onClick={onClose}
          >
            <X size={20} />
          </Button>
        </header>
        {children}
      </div>
      <ToastRegion owner={id} />
    </dialog>
  );
}
