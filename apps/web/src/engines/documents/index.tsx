import { Navigate, useParams } from 'react-router';
import { useApi } from '../../core/hooks';
import { Loading } from '../../ui/Page';
import type { DocKind } from '../../core/types';
import { DocumentList } from './DocumentList';
import { DocumentEditor } from './DocumentEditor';
import { DocumentView } from './DocumentView';
import { KIND_UI } from './kinds';

const routesFor = (kind: DocKind) => {
  const base = KIND_UI[kind].base;
  return [
    { path: base, element: <DocumentList key={kind} kind={kind} /> },
    { path: `${base}/new`, element: <DocumentEditor key={kind + '-new'} kind={kind} /> },
    { path: `${base}/:id`, element: <DocumentView key={kind + '-view'} kind={kind} /> },
    { path: `${base}/:id/edit`, element: <DocumentEditor key={kind + '-edit'} kind={kind} /> },
  ];
};

/** /documents/:id → the right page for whatever kind of document it is (used by journal links). */
function DocumentRedirect() {
  const { id } = useParams();
  const { data } = useApi<{ kind: DocKind }>(`/documents/${id}`);
  if (!data) return <Loading />;
  return <Navigate replace to={`${KIND_UI[data.kind].base}/${id}`} />;
}

/** The four pages of a document kind — mounted by the AR and AP modules. */
export const documentRoutes = routesFor;
export { DocumentRedirect };
