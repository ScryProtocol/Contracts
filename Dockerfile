FROM node:16
RUN mkdir /appdir
WORKDIR /appdir
ADD . /appdir
RUN npm i

ENTRYPOINT [ "node", "/appdir/morpheus.js" ]