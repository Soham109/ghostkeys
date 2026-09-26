export function FooterLinks() {
  return (
    <nav aria-label="Footer" className="flex flex-wrap gap-x-6 gap-y-2">
      {[
        ["/guide/", "Guide"],
        ["/pricing/", "Pricing"],
        ["/privacy/", "Privacy"],
        ["/compatibility/", "Compatibility"],
        ["/faq/", "FAQ"],
      ].map(([href, label]) => (
        <a key={href} href={href} className="label transition-colors hover:!text-ink">
          {label}
        </a>
      ))}
    </nav>
  );
}
