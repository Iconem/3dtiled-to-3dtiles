import { visit } from 'unist-util-visit';

// Fumadocs' own code-block pipeline (rehype-code / shiki) has no concept of mermaid — it would
// otherwise just syntax-highlight the diagram source as inert text. Swap ```mermaid fences for a
// <Mermaid chart="..."> JSX node BEFORE that pipeline runs, so the client component (src/components/
// mermaid.tsx, registered in mdx.tsx) renders the real diagram instead.
export function remarkMermaid() {
  return (tree: any) => {
    // Untyped single-visitor overload (no 'code' test string) instead of visit(tree, 'code', ...) —
    // that overload's generic Test/BuildVisitor typing doesn't resolve cleanly against an `any` tree
    // under Next's stricter production type-check (works fine in plain `tsc --noEmit`, fails
    // `next build`'s), so filter on node.type manually instead.
    visit(tree, (node: any, index: any, parent: any) => {
      if (node.type !== 'code' || node.lang !== 'mermaid' || !parent || index == null) return;
      parent.children[index] = {
        type: 'mdxJsxFlowElement',
        name: 'Mermaid',
        attributes: [{ type: 'mdxJsxAttribute', name: 'chart', value: node.value }],
        children: [],
      };
    });
  };
}
