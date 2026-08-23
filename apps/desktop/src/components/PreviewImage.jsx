import { useEffect, useState } from "react";

export default function PreviewImage({
  src,
  alt,
  scrollRootRef,
  className,
  fit = "cover",
  placeholderLabel = "No preview",
  onLoadError,
}) {
  const [container, setContainer] = useState(null);
  const [shouldLoad, setShouldLoad] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [errored, setErrored] = useState(false);

  useEffect(() => {
    setLoaded(false);
    setShouldLoad(false);
    setErrored(false); // new src (e.g. a cache-busted retry) → give it a fresh chance
  }, [src]);

  useEffect(() => {
    if (!src || !container) return undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setShouldLoad(true);
          observer.disconnect();
        }
      },
      {
        root: scrollRootRef?.current || null,
        rootMargin: "600px 0px 600px 0px",
        threshold: 0.01,
      },
    );
    observer.observe(container);
    return () => observer.disconnect();
  }, [src, container, scrollRootRef]);

  return (
    <div ref={setContainer} className="relative h-full w-full overflow-hidden">
      <div className="absolute inset-0 animate-pulse bg-[rgba(255,255,255,0.04)] dark:bg-[rgba(255,255,255,0.03)]" />
      {!src ? (
        <div className="absolute inset-0 flex items-center justify-center text-[11px] text-muted">{placeholderLabel}</div>
      ) : null}
      {src && shouldLoad && !errored ? (
        <img
          // A cached/instant source (blob:, warm cache) can finish before
          // React attaches onLoad — the ref catches that missed event.
          ref={(el) => { if (el && el.complete && el.naturalWidth > 0) setLoaded(true); }}
          src={src}
          alt={alt}
          loading="lazy"
          decoding="async"
          className={[
            "absolute inset-0 h-full w-full transition-[opacity,transform] duration-300 ease-out group-hover:scale-[1.03]",
            loaded ? "opacity-100" : "opacity-0",
            fit === "contain" ? "object-contain" : "object-cover",
            className || "",
          ].join(" ")}
          onLoad={() => setLoaded(true)}
          onError={() => { setErrored(true); onLoadError?.(); }}
        />
      ) : null}
      {errored ? (
        <div className="absolute inset-0 flex items-center justify-center text-[11px] text-muted">{placeholderLabel}</div>
      ) : null}
    </div>
  );
}
