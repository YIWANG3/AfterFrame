/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Plus Jakarta Sans"', "system-ui", "sans-serif"],
      },
      colors: {
        app: "rgb(var(--app-bg) / <alpha-value>)",
        chrome: "rgb(var(--chrome-bg) / <alpha-value>)",
        sidebar: "rgb(var(--sidebar-bg) / <alpha-value>)",
        panel: "rgb(var(--panel-bg) / <alpha-value>)",
        panel2: "rgb(var(--panel-bg-2) / <alpha-value>)",
        hover: "rgb(var(--hover-bg) / <alpha-value>)",
        selected: "rgb(var(--selected-bg) / <alpha-value>)",
        border: "rgb(var(--border-color) / <alpha-value>)",
        muted: "rgb(var(--muted-text) / <alpha-value>)",
        muted2: "rgb(var(--muted-text-2) / <alpha-value>)",
        text: "rgb(var(--text-color) / <alpha-value>)",
        accent: "rgb(var(--accent-color) / <alpha-value>)",
        accentSoft: "rgb(var(--accent-soft) / <alpha-value>)",
        accentInk: "rgb(var(--accent-ink) / <alpha-value>)",
        glow: "rgb(var(--glow-accent) / <alpha-value>)",
        success: "rgb(var(--success-color) / <alpha-value>)",
        warn: "rgb(var(--warn-color) / <alpha-value>)",
        error: "rgb(var(--error-color) / <alpha-value>)",
      },
      boxShadow: {
        overlay: "var(--shadow-overlay)",
        menu: "var(--shadow-menu)",
        glow: "0 0 0 2.5px rgb(var(--accent-color))",
        "card-hover": "none",
      },
      // 圆角体系:小控件 10 / 菜单胶囊 14 / 大面板 18(Tahoe 皮肤)
      borderRadius: {
        md: "10px",
        lg: "14px",
        xl: "18px",
        "2xl": "22px",
        app: "10px",
      },
      gridTemplateColumns: {
        app: "var(--sidebar-width, 240px) minmax(0, 1fr) var(--inspector-width, 300px)",
      },
    },
  },
  plugins: [],
};
