import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Prismaxim — Stem Splitter & Studio',
  description:
    'Extract audio from YouTube or a file, split it into stems with Demucs, and remix in a studio-style multitrack editor.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
