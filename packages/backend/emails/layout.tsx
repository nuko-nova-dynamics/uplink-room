/**
 * The frame every Uplink Room email shares (DESIGN.md, light theme): the cool white ground, one
 * white panel with a hairline edge, and the wordmark's text above it. Email clients can't place
 * the wordmark's amber dot without an image, and these emails load nothing remote (no images, no
 * fonts, no pixel), so the wordmark is its bold lowercase text alone. Atkinson Hyperlegible is
 * named first for readers who have it; everyone else gets their system's sans.
 */
import type { CSSProperties, ReactNode } from "react";
import { Body, Button, Container, Head, Hr, Html, Link, Preview, Section, Text } from "react-email";

export const color = {
  ground: "#F7F8FA",
  panel: "#FFFFFF",
  line: "#DFE2E7",
  text: "#15171A",
  muted: "#5B6069",
};

const ui =
  '"Atkinson Hyperlegible Next", -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif';
const mono = '"Atkinson Hyperlegible Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace';

export const text: CSSProperties = {
  margin: "0 0 16px",
  fontSize: "16px",
  lineHeight: "24px",
  color: color.text,
};

export const quiet: CSSProperties = { ...text, fontSize: "14px", lineHeight: "22px", color: color.muted };

export const link: CSSProperties = { color: color.text, textDecoration: "underline" };

export function Layout({
  title,
  preview,
  children,
  footer,
}: {
  /** The subject line, which is also the document's title. */
  title: string;
  preview: string;
  children: ReactNode;
  footer: ReactNode;
}) {
  return (
    <Html lang="en" dir="ltr">
      <Head>
        <title>{title}</title>
        <meta name="color-scheme" content="light" />
        <meta name="supported-color-schemes" content="light" />
      </Head>
      <Body style={{ margin: 0, padding: 0, backgroundColor: color.ground, fontFamily: ui }}>
        {/* The subject is the title (Head); the preview line stays out of it. */}
        <Preview useTitleTag={false}>{preview}</Preview>
        <Container lang="en" dir="ltr" style={{ maxWidth: "560px", margin: "0 auto", padding: "32px 16px" }}>
          <Text
            style={{
              margin: "0 0 16px 4px",
              fontSize: "18px",
              lineHeight: "24px",
              fontWeight: 700,
              color: color.text,
            }}
          >
            uplink room
          </Text>
          <Section
            style={{
              backgroundColor: color.panel,
              border: `1px solid ${color.line}`,
              borderRadius: "10px",
              padding: "28px 28px 12px",
            }}
          >
            {children}
          </Section>
          <Section style={{ padding: "16px 4px 0" }}>{footer}</Section>
        </Container>
      </Body>
    </Html>
  );
}

export function Title({ children }: { children: ReactNode }) {
  return (
    <h1 style={{ margin: "0 0 16px", fontSize: "24px", lineHeight: "32px", fontWeight: 700, color: color.text }}>
      {children}
    </h1>
  );
}

/** The one action, filled in the text color like the app's primary button. */
export function Action({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Section style={{ margin: "8px 0 24px" }}>
      <Button
        href={href}
        style={{
          backgroundColor: color.text,
          color: "#FFFFFF",
          fontSize: "16px",
          lineHeight: "24px",
          fontWeight: 700,
          textDecoration: "none",
          borderRadius: "8px",
          padding: "12px 20px",
          boxSizing: "border-box",
        }}
      >
        {children}
      </Button>
    </Section>
  );
}

/** A token to copy by hand: monospace, so every character can be told apart. */
export function Token({ value }: { value: string }) {
  return (
    <Section
      style={{
        margin: "0 0 16px",
        backgroundColor: color.ground,
        border: `1px solid ${color.line}`,
        borderRadius: "8px",
        padding: "12px 14px",
      }}
    >
      <Text style={{ margin: 0, fontFamily: mono, fontSize: "14px", lineHeight: "22px", color: color.text, wordBreak: "break-all" }}>
        {value}
      </Text>
    </Section>
  );
}

export function Rule() {
  return <Hr style={{ margin: "8px 0 20px", border: "none", borderTop: `1px solid ${color.line}` }} />;
}

export function Footer({ children }: { children: ReactNode }) {
  return <Text style={{ ...quiet, fontSize: "13px", lineHeight: "20px", margin: "0 0 8px" }}>{children}</Text>;
}

export { Link };
