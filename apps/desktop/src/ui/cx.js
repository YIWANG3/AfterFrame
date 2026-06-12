// Single classNames joiner — replaces the ad-hoc [..].join(" ") arrays and
// per-file cx() definitions scattered across components.
export default function cx(...values) {
  return values.filter(Boolean).join(" ");
}
