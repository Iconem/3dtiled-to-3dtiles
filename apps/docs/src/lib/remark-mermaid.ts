import { visit } from 'unist-util-visit';

// Fumadocs' own code-block pipeline (rehype-code / shiki) has no concept of mermaid — it would
// otherwise just syntax-highlight the diagram source as inert text. Swap ```mermaid fences for a
// <Mermaid chart="..."> JSX node BEFORE that pipeline runs, so the client component (src/components/
// mermaid.tsx, registered in mdx.tsx) renders the real diagram instead.
export function remarkMermaid() {
  return (tree: any) => {
    visit(tree, 'code', (node: any, index: number | null, parent: any) => {
      if (node.lang !== 'mermaid' || !parent || index == null) return;
      parent.children[index] = {
        type: 'mdxJsxFlowElement',
        name: 'Mermaid',
        attributes: [{ type: 'mdxJsxAttribute', name: 'chart', value: node.value }],
        children: [],
      };
    });
  };
}
