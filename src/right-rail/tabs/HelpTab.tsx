/**
 * Help tab — plain-language guide to the writer's desk, the library, and the
 * approval loop. Content is verified against real save/review behavior; no
 * screenshots (they rot, text tracks behavior).
 * adr: adr/right-rail.md
 */
import type { RightRailTabProps } from '../types';

export default function HelpTab(_props: RightRailTabProps) {
  return (
    <div className="help-tab">
      <div className="appearance-section">
        <div className="appearance-section-header">
          <span className="appearance-section-title">The flow</span>
        </div>
        <p><strong>Adopt</strong> an article from the library → <strong>write</strong> on your desk → <strong>submit</strong> for approval → it comes back <em>in the library</em> (approved) or <em>returned with notes</em> (fix, submit again).</p>
        <button
          type="button"
          className="help-replay"
          onClick={() => window.dispatchEvent(new CustomEvent('ow-replay-tour'))}
        >
          Replay the tour
        </button>
      </div>

      <div className="appearance-section">
        <div className="appearance-section-header">
          <span className="appearance-section-title">The library</span>
        </div>
        <p>The library is where the site's approved writing lives. It mirrors to every desk — you read it, borrow from it, and your approved writing joins it. You cannot edit a library article in place: <strong>Adopt</strong> checks a copy out to your desk, yours to edit.</p>
      </div>

      <div className="appearance-section">
        <div className="appearance-section-header">
          <span className="appearance-section-title">Saving, three ways</span>
        </div>
        <ol>
          <li><strong>Typing is saved as you write.</strong> Look at the chip at the top: <em>Saved</em> means your desk has it.</li>
          <li><strong>Suggested changes</strong> from your writing companion wait in the margin until you accept or reject them. Nothing moves into the page until you say yes.</li>
          <li><strong>Snapshots.</strong> The app keeps past snapshots in History so you can always look back.</li>
        </ol>
      </div>

      <div className="appearance-section">
        <div className="appearance-section-header">
          <span className="appearance-section-title">Submitting for approval</span>
        </div>
        <p>In the Review tab, press <em>Submit for approval</em> — or just ask your companion. Your article goes to the library as a review copy; it is not published yet. After that:</p>
        <ol>
          <li><em>Sent for review</em> — the reviewer will see it in the library.</li>
          <li><em>In review</em> — the reviewer is reading it.</li>
          <li>Either <em>in the library</em> (approved) or <em>returned with notes</em> (read the notes, fix, submit again).</li>
        </ol>
      </div>

      <div className="appearance-section">
        <div className="appearance-section-header">
          <span className="appearance-section-title">Your writing companion</span>
        </div>
        <p>Use the Chat tab to ask for edits. To point it at something specific, select the text on the page and press <em>Discuss with agent</em> in the toolbar that appears over your selection (or just click into the chat box) — the selection is quoted in your next message. By default your companion proposes changes and you accept or reject each one. If you want it to write straight onto the page — for example a first full draft you will edit yourself — turn on <em>Let the companion edit directly</em> above the chat, and turn it off when you want approval back on.</p>
      </div>

      <div className="appearance-section">
        <div className="appearance-section-header">
          <span className="appearance-section-title">Glossary</span>
        </div>
        <table className="help-glossary">
          <tbody>
            <tr><td>the library</td><td>Where the site's approved articles live — every desk mirrors it.</td></tr>
            <tr><td>your desk</td><td>Your personal writing space for drafts.</td></tr>
            <tr><td>adopt</td><td>Check an article out of the library to your desk. Your copy is yours to edit; the library's copy stays on the shelf.</td></tr>
            <tr><td>Checked out</td><td>The chip on an article whose copy is on your desk — you're holding the book.</td></tr>
            <tr><td>submit for approval</td><td>Send the article to the reviewer as a review copy in the library. Some apps call this publishing — here a person approves it first.</td></tr>
            <tr><td>in the library</td><td>Approved and final. Some apps call this publishing — here it lands in the library.</td></tr>
            <tr><td>returned with notes</td><td>The reviewer sent it back with feedback. Some apps call this changes requested.</td></tr>
            <tr><td>return</td><td>Return a borrowed article to the library and discard your desk copy. Your text stays in History.</td></tr>
            <tr><td>Unfiled</td><td>Library articles that don't belong to a series folder.</td></tr>
            <tr><td>suggested changes</td><td>Proposed edits waiting for your approval.</td></tr>
            <tr><td>snapshot</td><td>A saved point in History you can restore.</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
