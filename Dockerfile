FROM node:16
RUN mkdir /appdir
WORKDIR /appdir
COPY . /appdir
RUN npm i

ENTRYPOINT [ "node", "/appdir/morpheus.js" ]