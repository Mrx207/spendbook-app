export const metadata = {
  title: "Spendbook",
  appleWebApp: { capable: true, title: "Spendbook", statusBarStyle: "black-translucent" },
};
export const viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#0E1420",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head>
        <link rel="apple-touch-icon" href="/icon.png" />
        <meta name="mobile-web-app-capable" content="yes" />
        <link rel="manifest" href="/manifest.json" />
      </head>
      <body style={{ margin: 0, background: "#0E1420" }}>{children}</body>
    </html>
  );
}
