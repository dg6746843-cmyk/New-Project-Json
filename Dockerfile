FROM eclipse-temurin:21-jre

WORKDIR /app

RUN curl -L \
    https://github.com/lavalink-devs/Lavalink/releases/download/4.0.8/Lavalink.jar \
    -o Lavalink.jar

COPY application.yml .

EXPOSE 2333

CMD ["java", "-Xms256M", "-Xmx768M", "-jar", "Lavalink.jar"]