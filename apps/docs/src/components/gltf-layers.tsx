import type { ReactNode } from 'react';

// How a glTF vertex attribute reaches the bytes of a .glb, and the two buffer view layouts glTF-Transform writes.
// Used by guide/supported-formats ("The glTF-Transform patch, explained").

const box = 'flex-1 rounded-lg border border-fd-border bg-fd-card px-3 py-2.5 text-sm';
const code = 'rounded bg-fd-secondary px-1 font-mono text-[12px]';
const POS = 'bg-blue-500';
const NOR = 'bg-teal-500';
const UV = 'bg-amber-500';
const PAD = 'border border-dashed border-fd-muted-foreground';

function C({ children }: { children: ReactNode }) {
  return <code className={code}>{children}</code>;
}

function Row({ name, sub, children }: { name: string; sub: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 sm:flex-row sm:gap-3">
      <div className="font-semibold sm:w-36 sm:shrink-0">
        {name}
        <span className="block text-xs font-normal text-fd-muted-foreground">{sub}</span>
      </div>
      <div className={box}>{children}</div>
    </div>
  );
}

function Arrow({ children }: { children: ReactNode }) {
  return <div className="text-xs text-fd-muted-foreground sm:pl-40">↓ {children}</div>;
}

function Cells({ colors, w = 'w-3' }: { colors: string[]; w?: string }) {
  return (
    <div className="mt-1.5 flex flex-wrap gap-0.5">
      {colors.map((c, i) => (c === 'gap' ? <span key={i} className="w-1.5" /> : <span key={i} className={`h-4 ${w} rounded-sm ${c}`} />))}
    </div>
  );
}

const vertex = [POS, POS, POS, NOR, NOR, NOR, UV, UV];

export function GltfLayers() {
  return (
    <div className="not-prose my-6 flex flex-col gap-3">
      <Row name="Vertex attribute" sub="mesh level">
        A primitive says <C>POSITION → accessor 0</C>, <C>NORMAL → accessor 1</C>, <C>TEXCOORD_0 → accessor 2</C>: one
        value per vertex, per attribute.
      </Row>
      <Arrow>points to</Arrow>
      <Row name="Accessor" sub="how to read the bytes">
        <C>type: VEC3</C> · <C>componentType: FLOAT</C> · <C>count: 300000</C> · <C>bufferView: 0</C>. The typed
        description of the data: what one element looks like, and how many there are.
      </Row>
      <Row name="Element" sub="one vertex's value">
        One position is one <C>VEC3</C> element: three components, <C>x y z</C>.
      </Row>
      <Row name="Component" sub="one number">
        Each of <C>x</C>, <C>y</C>, <C>z</C> is a float32: 4 bytes. A <C>VEC3</C> float element is 12 bytes.
      </Row>
      <Row name="Typed array" sub="in JavaScript">
        glTF-Transform keeps an accessor&apos;s components as one flat <C>Float32Array</C>:{' '}
        <C>[x0,y0,z0, x1,y1,z1, …]</C>, 900 000 numbers. Its bytes are what the file needs, when nothing else is mixed in.
      </Row>
      <Arrow>written into</Arrow>
      <Row name="Buffer view" sub="a byte range">
        A slice of the buffer (<C>byteOffset</C>, <C>byteLength</C>, optional <C>byteStride</C>), holding one accessor
        (separate layout) or several, mixed per vertex (interleaved).
      </Row>
      <Row name="Buffer" sub="the raw bytes">
        The binary chunk of the .glb. Nothing typed here, only bytes.
      </Row>

      <div className="mt-2 flex flex-wrap gap-3 text-xs">
        <span className="inline-flex items-center gap-1"><span className={`size-3 rounded-sm ${POS}`} />position</span>
        <span className="inline-flex items-center gap-1"><span className={`size-3 rounded-sm ${NOR}`} />normal</span>
        <span className="inline-flex items-center gap-1"><span className={`size-3 rounded-sm ${UV}`} />uv</span>
        <span className="inline-flex items-center gap-1"><span className={`size-3 rounded-sm ${PAD}`} />padding</span>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className={box}>
          <b>Interleaved</b>: one buffer view, each vertex&apos;s attributes side by side (a 32-byte stride). Needs a
          per-component copy.
          <Cells colors={[...vertex, 'gap', ...vertex]} />
          <div className="mt-1 text-xs text-fd-muted-foreground">one square = one 4-byte component</div>
        </div>
        <div className={box}>
          <b>Separate</b>, glTF-Transform&apos;s default: one buffer view per attribute, each one byte for byte its
          typed array.
          <Cells colors={Array(9).fill(POS)} />
          <Cells colors={Array(9).fill(NOR)} />
          <Cells colors={Array(6).fill(UV)} />
        </div>
      </div>
      <div className={box}>
        <b>Padding.</b> Each element of a vertex attribute starts on a 4-byte boundary. A <C>VEC3</C> of bytes (an RGB
        colour) is 3 bytes, so every element gets one byte of padding and the packed typed array no longer matches the
        view:
        <Cells w="w-2" colors={[NOR, NOR, NOR, PAD, 'gap', NOR, NOR, NOR, PAD, 'gap', NOR, NOR, NOR, PAD]} />
        <div className="mt-1 text-xs text-fd-muted-foreground">one square = 1 byte</div>
        <C>VEC3</C>/<C>VEC2</C> floats (12 and 8 bytes), a <C>VEC4</C> of bytes (4) and a 4-byte <C>SCALAR</C> need none; a 1- or 2-byte scalar (a <C>_BATCHID</C> as uint8) is padded too.
      </div>
    </div>
  );
}
