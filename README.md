# devtools-tests

Run as:
```sh
git clone https://github.com/pavelfeldman/devtools-tests
npm install
node runner.js -j 12 \
    --frontend_port=8080 \
    --chrome_port=9223 \
    /Users/pfeldman/code/chromium/src/third_party/WebKit/LayoutTests/inspector
```