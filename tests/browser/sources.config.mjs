import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: ".", testMatch:["unified-sources.e2e.mjs","photo-import.e2e.mjs"],timeout:30000,expect:{timeout:10000},workers:1,
  reporter:"list",outputDir:"../../artifacts/sources-browser",
  use:{baseURL:"http://127.0.0.1:4399",locale:"zh-CN",timezoneId:"Europe/Paris",launchOptions:{executablePath:process.env.CHROME_PATH || "/usr/bin/google-chrome",args:["--no-sandbox"]},screenshot:"only-on-failure",trace:"retain-on-failure"},
  projects:[{name:"desktop",use:{viewport:{width:1440,height:1000}}},{name:"phone",grep:/@phone/,use:{viewport:{width:390,height:844},isMobile:true,hasTouch:true}}],
  webServer:{command:"python3 -m http.server 4399 --bind 127.0.0.1 --directory dist",url:"http://127.0.0.1:4399",cwd:"../..",reuseExistingServer:false,stdout:"ignore",stderr:"ignore"},
});
