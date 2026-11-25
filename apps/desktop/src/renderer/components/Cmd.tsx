/**
 * A command as inline code that breaks only between its words, never inside one, so
 * `pnpm add -D tiled-map` can't split at the hyphen into "tiled-" and "map". Copying it gives the
 * command as written.
 */
export function Cmd({ text }: { text: string }) {
  const words = text.split(" ");
  return (
    <code className="cmd">
      {words.map((word, index) => (
        <span key={index}>
          {index > 0 ? " " : ""}
          <span className="cmd-word">{word}</span>
        </span>
      ))}
    </code>
  );
}
