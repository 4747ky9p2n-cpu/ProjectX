import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { readFile } from "node:fs/promises";

// Read the business name from site.json at request time.
const getBusinessName = createServerFn({ method: "GET" }).handler(async () => {
  try {
    const cfg = JSON.parse(await readFile("site.json", "utf8")) as {
      businessName?: string;
    };
    return cfg.businessName?.trim() ?? "";
  } catch {
    return "";
  }
});

export const Route = createFileRoute("/")({
  loader: () => getBusinessName(),
  component: Home,
});

function Home() {
  const businessName = Route.useLoaderData();

  return (
    <div className="min-h-dvh bg-[#0a0a0a] text-white">
      {/* ─── Hero ─── */}
      <Hero businessName={businessName} />

      {/* ─── Features ─── */}
      <Features />

      {/* ─── How It Works ─── */}
      <HowItWorks />

      {/* ─── Footer ─── */}
      <Footer />
    </div>
  );
}

/* ─────────────────────────────────────────────
   Hero
   ───────────────────────────────────────────── */
function Hero({ businessName }: { businessName: string }) {
  return (
    <section className="relative flex min-h-dvh flex-col items-center justify-center overflow-hidden px-6 pt-20 pb-24 text-center">
      {/* Background gradient blobs */}
      <div className="pointer-events-none absolute inset-0 select-none">
        <div className="absolute -top-40 left-1/2 h-[500px] w-[800px] -translate-x-1/2 rounded-full bg-gradient-to-r from-red-600/20 via-purple-600/20 to-pink-600/10 blur-3xl" />
        <div className="absolute top-1/3 left-1/4 h-[300px] w-[500px] rounded-full bg-gradient-to-br from-red-500/15 to-purple-600/15 blur-3xl" />
      </div>

      <div className="relative z-10 max-w-3xl">
        {/* Badge */}
        <span className="mb-6 inline-block rounded-full border border-red-500/30 bg-red-500/10 px-4 py-1.5 text-sm font-medium text-red-400">
          AI-Powered Video Clipping
        </span>

        <h1 className="mb-6 text-5xl font-bold leading-tight tracking-tight sm:text-6xl lg:text-7xl">
          Turn Any YouTube Video{" "}
          <span className="bg-gradient-to-r from-red-500 via-purple-500 to-pink-500 bg-clip-text text-transparent">
            Into Viral Shorts
          </span>
        </h1>

        <p className="mx-auto mb-10 max-w-xl text-lg leading-relaxed text-gray-400 sm:text-xl">
          {businessName || "ClipFlow"} analyzes videos, finds the moments people
          can't stop watching, and creates ready-to-upload Shorts — with titles
          and descriptions. All in seconds.
        </p>

        <a
          href="/app"
          className="group inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-red-600 to-purple-600 px-8 py-4 text-lg font-semibold text-white shadow-lg shadow-red-600/25 transition-all hover:from-red-500 hover:to-purple-500 hover:shadow-red-500/30 active:scale-95"
        >
          Try It Free
          <svg
            className="h-5 w-5 transition-transform group-hover:translate-x-1"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M13 7l5 5m0 0l-5 5m5-5H6"
            />
          </svg>
        </a>

        <p className="mt-4 text-sm text-gray-600">
          No credit card required · Free to start
        </p>
      </div>
    </section>
  );
}

/* ─────────────────────────────────────────────
   Features
   ───────────────────────────────────────────── */
function Features() {
  const items = [
    {
      icon: LinkIcon,
      title: "Paste Any URL",
      description:
        "Drop in a YouTube link. ClipFlow extracts the transcript and analyzes it instantly.",
    },
    {
      icon: SparklesIcon,
      title: "AI-Powered Clips",
      description:
        "Our AI identifies hooks, emotional peaks, and high-retention moments — the stuff that goes viral.",
    },
    {
      icon: UploadIcon,
      title: "Ready to Upload",
      description:
        "Get finished Shorts with AI-generated titles and descriptions. Download and post.",
    },
  ];

  return (
    <section className="border-t border-white/5 px-6 py-24">
      <div className="mx-auto max-w-6xl">
        <h2 className="mb-16 text-center text-3xl font-bold tracking-tight sm:text-4xl">
          Everything you need to{" "}
          <span className="bg-gradient-to-r from-red-400 to-purple-400 bg-clip-text text-transparent">
            clip smarter
          </span>
        </h2>

        <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((item) => (
            <div
              key={item.title}
              className="group rounded-2xl border border-white/5 bg-white/[0.02] p-8 transition-all hover:border-red-500/20 hover:bg-white/[0.04]"
            >
              <div className="mb-5 inline-flex rounded-xl bg-gradient-to-br from-red-600/20 to-purple-600/20 p-3">
                <item.icon />
              </div>
              <h3 className="mb-3 text-xl font-semibold">{item.title}</h3>
              <p className="leading-relaxed text-gray-400">{item.description}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ─────────────────────────────────────────────
   How It Works
   ───────────────────────────────────────────── */
function HowItWorks() {
  const steps = [
    {
      number: "1",
      title: "Connect your YouTube channel",
      description:
        "Link your channel with one click. ClipFlow gets read access to your videos so it can work its magic.",
    },
    {
      number: "2",
      title: "Pick a video or channel to clip from",
      description:
        "Drop in any YouTube URL — your own or someone else's. ClipFlow pulls the transcript and gets to work.",
    },
    {
      number: "3",
      title: "Get viral-ready Shorts delivered",
      description:
        "ClipFlow identifies the best moments, creates the clips, and writes titles and descriptions — ready to post.",
    },
  ];

  return (
    <section className="border-t border-white/5 px-6 py-24">
      <div className="mx-auto max-w-4xl">
        <h2 className="mb-16 text-center text-3xl font-bold tracking-tight sm:text-4xl">
          How it{" "}
          <span className="bg-gradient-to-r from-red-400 to-purple-400 bg-clip-text text-transparent">
            works
          </span>
        </h2>

        <div className="space-y-12">
          {steps.map((step, i) => (
            <div key={step.number} className="flex gap-6 sm:gap-8">
              {/* Step number with connecting line */}
              <div className="relative flex flex-col items-center">
                <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-red-600 to-purple-600 text-lg font-bold shadow-lg shadow-red-600/20">
                  {step.number}
                </div>
                {i < steps.length - 1 && (
                  <div className="mt-3 h-full w-px bg-gradient-to-b from-red-500/30 to-transparent" />
                )}
              </div>

              <div className="pb-12">
                <h3 className="mb-2 text-xl font-semibold">{step.title}</h3>
                <p className="leading-relaxed text-gray-400">
                  {step.description}
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ─────────────────────────────────────────────
   Footer
   ───────────────────────────────────────────── */
function Footer() {
  return (
    <footer className="border-t border-white/5 px-6 py-8">
      <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 text-sm text-gray-600 sm:flex-row">
        <p>&copy; 2025 ClipFlow</p>
        <p>
          Built with{" "}
          <a
            href="https://cto.new"
            className="underline transition-colors hover:text-gray-400"
          >
            cto.new
          </a>
        </p>
      </div>
    </footer>
  );
}

/* ─────────────────────────────────────────────
   Icons (inline SVGs)
   ───────────────────────────────────────────── */
function LinkIcon() {
  return (
    <svg
      className="h-6 w-6 text-red-400"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={1.5}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m13.35-.622l1.757-1.757a4.5 4.5 0 00-6.364-6.364l-4.5 4.5a4.5 4.5 0 001.242 7.244"
      />
    </svg>
  );
}

function SparklesIcon() {
  return (
    <svg
      className="h-6 w-6 text-purple-400"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={1.5}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 00-2.455 2.456zM16.894 20.567L16.5 21.75l-.394-1.183a2.25 2.25 0 00-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 001.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 001.423 1.423l1.183.394-1.183.394a2.25 2.25 0 00-1.423 1.423z"
      />
    </svg>
  );
}

function UploadIcon() {
  return (
    <svg
      className="h-6 w-6 text-pink-400"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={1.5}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5"
      />
    </svg>
  );
}
