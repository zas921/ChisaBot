import type { Spec } from "@json-render/core";

/** Give existing vertical Heading sections a toggle without changing the saved spec or element keys. */
export function foldablePanelSections<T extends Spec | null>(spec: T): T {
  if (!spec) return spec;
  const original = spec.elements;
  const elements = { ...original };
  const level = (key: string) => original[key]?.props?.level as number | undefined ?? 2;
  const isHeading = (key: string) => original[key]?.type === "Heading" && Boolean(original[key]?.props?.text) && !original[key]?.repeat;

  function group(children: string[]): string[] {
    const grouped: string[] = [];
    for (let index = 0; index < children.length; index++) {
      const key = children[index]!;
      grouped.push(key);
      if (!isHeading(key)) continue;
      let end = index + 1;
      while (end < children.length && !(isHeading(children[end]!) && level(children[end]!) <= level(key))) end++;
      if (end === index + 1) continue;
      const heading = original[key]!;
      elements[key] = {
        ...heading,
        type: "Accordion",
        props: { title: heading.props.text, icon: heading.props.icon, open: true },
        children: group(children.slice(index + 1, end)),
      };
      index = end - 1;
    }
    return grouped;
  }

  for (const [key, element] of Object.entries(original)) {
    if ((element.type === "Stack" && element.props?.direction !== "horizontal") || element.type === "Card") {
      elements[key] = { ...element, children: group(element.children ?? []) };
    }
  }
  return { ...spec, elements } as T;
}
