/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // One brand accent, used for the chrome and for anything interactive.
        // Stage colours stay separate: they carry meaning, this one carries
        // identity, and mixing the two is how a UI stops being readable.
        brand: {
          50: "#eef2ff",
          100: "#e0e7ff",
          200: "#c7d2fe",
          400: "#818cf8",
          500: "#6366f1",
          600: "#4f46e5",
          700: "#4338ca",
          900: "#312e81",
        },
      },
      boxShadow: {
        card: "0 1px 2px rgba(15,23,42,0.06), 0 1px 3px rgba(15,23,42,0.04)",
        raised: "0 2px 4px rgba(15,23,42,0.06), 0 6px 16px rgba(15,23,42,0.06)",
        panel: "0 10px 30px rgba(15,23,42,0.14), 0 2px 8px rgba(15,23,42,0.08)",
      },
    },
  },
  plugins: [],
};
