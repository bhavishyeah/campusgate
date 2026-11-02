/**
 * Inline danger panel for a failed primary data load (reuses the existing
 * .bg-danger-50 idiom) so a screen isn't left blank. role="alert".
 */
export function InlineError({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="bg-danger-50 border border-danger-500 text-danger-700 px-4 py-3 rounded-lg text-sm"
    >
      {message}
    </div>
  );
}
