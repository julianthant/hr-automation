@import "tailwindcss";

@custom-variant dark (&:is(.dark *));

:root {
  --background: hsl(30 28.5714% 97.2549%);
  --foreground: hsl(12 21.7391% 9.0196%);
  --card: hsl(0 0% 100%);
  --card-foreground: hsl(12 21.7391% 9.0196%);
  --popover: hsl(0 0% 100%);
  --popover-foreground: hsl(12 21.7391% 9.0196%);
  --primary: hsl(22.7273 82.5000% 31.3725%);
  --primary-foreground: hsl(0 0% 100%);
  --secondary: hsl(21.4286 77.7778% 96.4706%);
  --secondary-foreground: hsl(21.3158 55.0725% 27.0588%);
  --muted: hsl(33.3333 25.7143% 93.1373%);
  --muted-foreground: hsl(22.5000 7.0175% 44.7059%);
  --accent: hsl(26.6667 69.2308% 87.2549%);
  --accent-foreground: hsl(21.3158 55.0725% 27.0588%);
  --destructive: hsl(0 68.3761% 45.8824%);
  --destructive-foreground: hsl(0 0% 100%);
  --border: hsl(28.0000 21.1268% 86.0784%);
  --input: hsl(28.0000 21.1268% 86.0784%);
  --ring: hsl(22.7273 82.5000% 31.3725%);
  --chart-1: hsl(22.7273 82.5000% 31.3725%);
  --chart-2: hsl(25.9649 90.4762% 37.0588%);
  --chart-3: hsl(17.4725 88.3495% 40.3922%);
  --chart-4: hsl(35.4545 91.6667% 32.9412%);
  --chart-5: hsl(31.7647 80.9524% 28.8235%);
  --sidebar: hsl(33.3333 23.0769% 92.3529%);
  --sidebar-foreground: hsl(12 21.7391% 9.0196%);
  --sidebar-primary: hsl(22.7273 82.5000% 31.3725%);
  --sidebar-primary-foreground: hsl(0 0% 100%);
  --sidebar-accent: hsl(31.3043 33.3333% 86.4706%);
  --sidebar-accent-foreground: hsl(21.3158 55.0725% 27.0588%);
  --sidebar-border: hsl(28.0000 21.1268% 86.0784%);
  --sidebar-ring: hsl(22.7273 82.5000% 31.3725%);
  --font-sans: "IBM Plex Sans", "Inter", ui-sans-serif, system-ui, -apple-system, sans-serif;
  --font-serif: "IBM Plex Serif", "Georgia", ui-serif, serif;
  --font-mono: "IBM Plex Mono", "Fira Code", ui-monospace, monospace;
  --radius: 0.5rem;
  --shadow-x: 0;
  --shadow-y: 1px;
  --shadow-blur: 3px;
  --shadow-spread: 0px;
  --shadow-opacity: 0.06;
  --shadow-color: #241005;
  --shadow-2xs: 0 1px 3px 0px hsl(21.2903 75.6098% 8.0392% / 0.03);
  --shadow-xs: 0 1px 3px 0px hsl(21.2903 75.6098% 8.0392% / 0.03);
  --shadow-sm: 0 1px 3px 0px hsl(21.2903 75.6098% 8.0392% / 0.06), 0 1px 2px -1px hsl(21.2903 75.6098% 8.0392% / 0.06);
  --shadow: 0 1px 3px 0px hsl(21.2903 75.6098% 8.0392% / 0.06), 0 1px 2px -1px hsl(21.2903 75.6098% 8.0392% / 0.06);
  --shadow-md: 0 1px 3px 0px hsl(21.2903 75.6098% 8.0392% / 0.06), 0 2px 4px -1px hsl(21.2903 75.6098% 8.0392% / 0.06);
  --shadow-lg: 0 1px 3px 0px hsl(21.2903 75.6098% 8.0392% / 0.06), 0 4px 6px -1px hsl(21.2903 75.6098% 8.0392% / 0.06);
  --shadow-xl: 0 1px 3px 0px hsl(21.2903 75.6098% 8.0392% / 0.06), 0 8px 10px -1px hsl(21.2903 75.6098% 8.0392% / 0.06);
  --shadow-2xl: 0 1px 3px 0px hsl(21.2903 75.6098% 8.0392% / 0.15);
  --tracking-normal: 0em;
  --spacing: 0.25rem;
}

.dark {
  --background: hsl(15 20.0000% 3.9216%);
  --foreground: hsl(24.0000 21.1268% 86.0784%);
  --card: hsl(15 11.1111% 7.0588%);
  --card-foreground: hsl(24.0000 21.1268% 86.0784%);
  --popover: hsl(15 14.2857% 5.4902%);
  --popover-foreground: hsl(24.0000 21.1268% 86.0784%);
  --primary: hsl(29.3182 41.9048% 58.8235%);
  --primary-foreground: hsl(27.2727 73.3333% 5.8824%);
  --secondary: hsl(15 16.6667% 9.4118%);
  --secondary-foreground: hsl(25.2632 9.3596% 60.1961%);
  --muted: hsl(15 15.3846% 10.1961%);
  --muted-foreground: hsl(22.5000 7.0175% 44.7059%);
  --accent: hsl(27.2727 35.4839% 12.1569%);
  --accent-foreground: hsl(30.6250 52.7473% 64.3137%);
  --destructive: hsl(0 84.2365% 60.1961%);
  --destructive-foreground: hsl(0 85.7143% 97.2549%);
  --border: hsl(25.0000 17.6471% 13.3333%);
  --input: hsl(27.6923 18.3099% 13.9216%);
  --ring: hsl(29.3182 41.9048% 58.8235%);
  --chart-1: hsl(29.3182 41.9048% 58.8235%);
  --chart-2: hsl(32.1327 94.6188% 43.7255%);
  --chart-3: hsl(12.5581 67.5393% 62.5490%);
  --chart-4: hsl(31.6535 65.1282% 61.7647%);
  --chart-5: hsl(28.2119 67.1111% 44.1176%);
  --sidebar: hsl(20 17.6471% 3.3333%);
  --sidebar-foreground: hsl(24.7059 17.1717% 80.5882%);
  --sidebar-primary: hsl(29.3182 41.9048% 58.8235%);
  --sidebar-primary-foreground: hsl(27.2727 73.3333% 5.8824%);
  --sidebar-accent: hsl(30 30.7692% 10.1961%);
  --sidebar-accent-foreground: hsl(30.6250 52.7473% 64.3137%);
  --sidebar-border: hsl(24 17.2414% 11.3725%);
  --sidebar-ring: hsl(29.3182 41.9048% 58.8235%);
  --font-sans: "IBM Plex Sans", "Inter", ui-sans-serif, system-ui, -apple-system, sans-serif;
  --font-serif: "IBM Plex Serif", "Georgia", ui-serif, serif;
  --font-mono: "IBM Plex Mono", "Fira Code", ui-monospace, monospace;
  --radius: 0.5rem;
  --shadow-x: 0;
  --shadow-y: 1px;
  --shadow-blur: 4px;
  --shadow-spread: 0px;
  --shadow-opacity: 0.4;
  --shadow-color: #010000;
  --shadow-2xs: 0 1px 4px 0px hsl(0 100.0000% 0.1961% / 0.20);
  --shadow-xs: 0 1px 4px 0px hsl(0 100.0000% 0.1961% / 0.20);
  --shadow-sm: 0 1px 4px 0px hsl(0 100.0000% 0.1961% / 0.40), 0 1px 2px -1px hsl(0 100.0000% 0.1961% / 0.40);
  --shadow: 0 1px 4px 0px hsl(0 100.0000% 0.1961% / 0.40), 0 1px 2px -1px hsl(0 100.0000% 0.1961% / 0.40);
  --shadow-md: 0 1px 4px 0px hsl(0 100.0000% 0.1961% / 0.40), 0 2px 4px -1px hsl(0 100.0000% 0.1961% / 0.40);
  --shadow-lg: 0 1px 4px 0px hsl(0 100.0000% 0.1961% / 0.40), 0 4px 6px -1px hsl(0 100.0000% 0.1961% / 0.40);
  --shadow-xl: 0 1px 4px 0px hsl(0 100.0000% 0.1961% / 0.40), 0 8px 10px -1px hsl(0 100.0000% 0.1961% / 0.40);
  --shadow-2xl: 0 1px 4px 0px hsl(0 100.0000% 0.1961% / 1.00);
}

@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-card: var(--card);
  --color-card-foreground: var(--card-foreground);
  --color-popover: var(--popover);
  --color-popover-foreground: var(--popover-foreground);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  --color-secondary: var(--secondary);
  --color-secondary-foreground: var(--secondary-foreground);
  --color-muted: var(--muted);
  --color-muted-foreground: var(--muted-foreground);
  --color-accent: var(--accent);
  --color-accent-foreground: var(--accent-foreground);
  --color-destructive: var(--destructive);
  --color-destructive-foreground: var(--destructive-foreground);
  --color-border: var(--border);
  --color-input: var(--input);
  --color-ring: var(--ring);
  --color-chart-1: var(--chart-1);
  --color-chart-2: var(--chart-2);
  --color-chart-3: var(--chart-3);
  --color-chart-4: var(--chart-4);
  --color-chart-5: var(--chart-5);
  --color-sidebar: var(--sidebar);
  --color-sidebar-foreground: var(--sidebar-foreground);
  --color-sidebar-primary: var(--sidebar-primary);
  --color-sidebar-primary-foreground: var(--sidebar-primary-foreground);
  --color-sidebar-accent: var(--sidebar-accent);
  --color-sidebar-accent-foreground: var(--sidebar-accent-foreground);
  --color-sidebar-border: var(--sidebar-border);
  --color-sidebar-ring: var(--sidebar-ring);

  --font-sans: var(--font-sans);
  --font-mono: var(--font-mono);
  --font-serif: var(--font-serif);

  --radius-sm: calc(var(--radius) - 4px);
  --radius-md: calc(var(--radius) - 2px);
  --radius-lg: var(--radius);
  --radius-xl: calc(var(--radius) + 4px);

  --shadow-2xs: var(--shadow-2xs);
  --shadow-xs: var(--shadow-xs);
  --shadow-sm: var(--shadow-sm);
  --shadow: var(--shadow);
  --shadow-md: var(--shadow-md);
  --shadow-lg: var(--shadow-lg);
  --shadow-xl: var(--shadow-xl);
  --shadow-2xl: var(--shadow-2xl);
}

@layer base {
  * {
    @apply border-border outline-ring/50;
  }
  body {
    @apply bg-background text-foreground;
  }
}