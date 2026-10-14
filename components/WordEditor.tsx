"use client";

import { useEffect, useRef, useState } from "react";

interface DocEditor {
  destroyEditor(): void;
}
declare global {
  interface Window {
    DocsAPI?: { DocEditor: new (id: string, config: object) => DocEditor };
  }
}

interface Props {
  onlyofficeUrl: string;
  config: object;
  busy: boolean;
  onFinish: () => void;
  onCancel: () => void;
}

const EDITOR_ID = "sp-word-editor";
const scriptPromises = new Map<string, Promise<void>>();

function loadApi(base: string): Promise<void> {
  const src = `${base}/web-apps/apps/api/documents/api.js`;
  let p = scriptPromises.get(src);
  if (!p) {
    p = new Promise<void>((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => {
        scriptPromises.delete(src);
        reject(new Error("The Word editor couldn't be loaded."));
      };
      document.head.appendChild(s);
    });
    scriptPromises.set(src, p);
  }
  return p;
}

/**
 * The ONLYOFFICE editor, embedded with download, print and copy switched off
 * (the server signs those permissions into the config, so the browser can't
 * change them). "Send for approval" force-saves; the edited file goes from
 * the Document Server to SafePrint, never through this browser.
 */
export default function WordEditor({ onlyofficeUrl, config, busy, onFinish, onCancel }: Props) {
  const editorRef = useRef<DocEditor | null>(null);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    loadApi(onlyofficeUrl)
      .then(() => {
        if (cancelled || !window.DocsAPI) return;
        editorRef.current = new window.DocsAPI.DocEditor(EDITOR_ID, {
          ...config,
          events: {
            onAppReady: () => setLoaded(true),
            onError: (e: { data?: { errorDescription?: string } }) =>
              setError(e.data?.errorDescription ?? "The Word editor reported an error."),
          },
        });
      })
      .catch((err: Error) => setError(err.message));
    return () => {
      cancelled = true;
      editorRef.current?.destroyEditor();
      editorRef.current = null;
    };
  }, [onlyofficeUrl, config]);

  return (
    <div className="word-editor">
      <p className="hint" style={{ marginTop: 0 }}>
        Fix the document, then send it to the customer. They see the result on their phone and approve
        it before you can print. Download, print and copy are switched off here.
      </p>
      {error && <p className="error">{error}</p>}
      {!loaded && !error && <p className="hint">Opening the Word editor…</p>}
      <div className="word-editor-frame">
        <div id={EDITOR_ID} />
      </div>
      <div className="row">
        <button type="button" className="btn secondary" onClick={onCancel} disabled={busy}>
          Discard edits
        </button>
        <button type="button" className="btn" onClick={onFinish} disabled={busy || !loaded}>
          {busy ? "Saving…" : "Send to customer for approval"}
        </button>
      </div>
    </div>
  );
}
