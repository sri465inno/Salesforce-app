import { startDemoService } from './app';

const port = Number(process.env.DEMO_SERVICE_PORT || 4100);
const fixedDefects = (process.env.DEMO_FIXED_DEFECTS || '').split(',').filter(Boolean);

startDemoService(port, { fixedDefects }).then((svc) => {
  console.log(`Demo reservation service (${svc.build}) listening on ${svc.url}`);
  console.log(`  UI:      ${svc.url}/`);
  console.log(`  GraphQL: ${svc.url}/graphql`);
});
