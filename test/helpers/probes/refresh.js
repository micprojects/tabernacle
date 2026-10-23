export function instrumentSource(source) {
  return (
    source +
    '\nwindow.retainedViewTabs = () => state?.tabs?.length || 0;\nwindow.retainedViewRevision = () => state?.revision;'
  );
}
