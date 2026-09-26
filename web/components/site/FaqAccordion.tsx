"use client";

import * as Accordion from "@radix-ui/react-accordion";

/** Minimal accordion: hairline rows, a plus that turns into a cross. Answers may contain links (trusted, from our own docs). */
export function FaqAccordion({ items }: { items: { q: string; a: string }[] }) {
  return (
    <Accordion.Root type="multiple">
      {items.map((f, i) => (
        <Accordion.Item key={f.q} value={`q${i}`} className="border-t hairline last:border-b">
          <Accordion.Header>
            <Accordion.Trigger className="group flex w-full items-baseline gap-6 py-6 text-left">
              <span className="flex-1 text-[19px] leading-[1.3] text-ink">{f.q}</span>
              <span aria-hidden className="label text-[16px] transition-transform duration-300 group-data-[state=open]:rotate-45">
                +
              </span>
            </Accordion.Trigger>
          </Accordion.Header>
          <Accordion.Content className="overflow-hidden data-[state=closed]:animate-[acc-up_280ms_var(--ease-snap)] data-[state=open]:animate-[acc-down_280ms_var(--ease-snap)]">
            <p className="prose-gk max-w-[60ch] pb-7 !text-[16px]" dangerouslySetInnerHTML={{ __html: f.a }} />
          </Accordion.Content>
        </Accordion.Item>
      ))}
    </Accordion.Root>
  );
}
