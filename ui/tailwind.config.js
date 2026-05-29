export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        base: '#0d1117',
        surface: '#161b22',
        elevated: '#21262d',
        border: '#30363d',
        'text-primary': '#e6edf3',
        'text-muted': '#8b949e',
        green: '#3fb950',
        blue: '#58a6ff',
        red: '#f85149',
        orange: '#d29922',
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'Fira Code', 'Cascadia Code', 'ui-monospace', 'monospace'],
      },
    },
  },
  plugins: [],
};
