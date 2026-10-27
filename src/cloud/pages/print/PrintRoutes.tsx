/**
 * PRINT — uploading a model, building a project, starting and following a
 * print: every address under /print, /files, /projects and /jobs
 * (src/cloud/routes.ts). The shell mounts this module behind
 * `<RequireSignIn>`, so whoever reaches it is signed in.
 *
 *   /print                    upload a file or import a link; what to pick up again
 *   /files                    the library: files and link imports
 *   /files/:id                one file: its check, measurements, printer fit
 *   /files/imports/:id        one link import: exactly what the server did
 *   /projects                 the projects
 *   /projects/:id             one project: models, plates, accessories, prints
 *   /projects/:id/print       material, printer and settings → «ask for an estimate»
 *   /jobs                     every print, by where it is
 *   /jobs/:id                 one print through its fourteen states: the
 *                             estimate and what confirming reserves, the
 *                             confirmation (an Idempotency-Key), the queue,
 *                             the printer's live reading, the timeline
 *
 * Each screen is a lazy chunk of its own. The section's shared pieces (kit,
 * model, and the words of strings/print.ts) are re-exported from here, so
 * they ride in this chunk — which every print screen needs first anyway —
 * rather than in small shared chunks (src/cloud/PrintCloudApp.tsx explains).
 */
import { Route, Routes } from 'react-router-dom';
import { prefetchable } from '../../../lib/routeReveal';
import { CloudNotFound } from '../../shell/Notices';

export * from './kit';
export * from './model';

const PrintStart = prefetchable(() => import('./PrintStart'));
const Library = prefetchable(() => import('./Library'));
const Projects = prefetchable(() => import('./Projects'));
const Configure = prefetchable(() => import('./Configure'));
const Jobs = prefetchable(() => import('./Jobs'));
const JobDetail = prefetchable(() => import('./JobDetail'));

export default function PrintRoutes() {
  return (
    <Routes>
      <Route path="/print" element={<PrintStart />} />
      <Route path="/files" element={<Library view="files" />} />
      <Route path="/files/imports/:id" element={<Library view="import" />} />
      <Route path="/files/:id" element={<Library view="file" />} />
      <Route path="/projects" element={<Projects view="list" />} />
      <Route path="/projects/:id" element={<Projects view="detail" />} />
      <Route path="/projects/:id/print" element={<Configure />} />
      <Route path="/jobs" element={<Jobs />} />
      <Route path="/jobs/:id" element={<JobDetail />} />
      <Route path="*" element={<CloudNotFound />} />
    </Routes>
  );
}
