/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./cms/**/*.{vue,js,ts,jsx,tsx,md}",
    "./cms/.vitepress/**/*.{vue,js,ts,jsx,tsx,md}",
  ],
  theme: {
    extend: {
      colors: {
        'tokyo': {
          'bg-dark': '#24283b',
          'bg-darker': '#1a1b26',
          'bg-float': '#1f2335',
          'bg-highlight': '#292e42',
          'fg': '#c0caf5',
          'fg-dark': '#a9b1d6',
          'purple': '#9d7cd8',
          'blue': '#7aa2f7',
          'cyan': '#7dcfff',
          'green': '#9ece6a',
          'yellow': '#e0af68',
          'red': '#f7768e',
          'magenta': '#bb9af7',
        }
      }
    },
  },
  plugins: [
    require('@tailwindcss/typography'),
  ],
}