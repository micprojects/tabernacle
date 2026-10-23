export function instrumentSource(source) {
  return source + '\nwindow.breadcrumbRequest = (type, args) => request(type, args);';
}
