import Link from 'next/link';

export default function HomePage() {
  return (
    <div className="flex flex-col justify-center text-center flex-1">
      <h1 className="text-2xl font-bold mb-4">3dtiled-to-3dtiles</h1>
      <p>
        Converters and a live streaming middleware from tiled point-cloud/mesh/Gaussian-splat formats
        to OGC 3D Tiles. See{' '}
        <Link href="/docs" className="font-medium underline">
          /docs
        </Link>
        .
      </p>
    </div>
  );
}
