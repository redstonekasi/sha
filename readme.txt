  REQUIREMENTS

* node.js 'jod' or later
* pnpm

  DEPLOY

cp index.mjs worker.js /opt/sha/
useradd -m -d /var/lib/sha -r -s /sbin/nologin sha
cp config.example.json /var/lib/sha/config.json

  SYSTEMD

[Unit]
Description=sheltupdate server supervisor
After=network.target

[Service]
User=sha
ExecStart=/usr/bin/node /opt/sha/index.mjs
Restart=on-failure

ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
PrivateUsers=yes

WorkingDirectory=/var/lib/sha
ReadWritePaths=/var/lib/sha

[Install]
WantedBy=multi-user.target

  OPENRC

#!/sbin/openrc-run
supervisor=supervise-daemon

name="sha"
description="sheltupdate server supervisor"

command=/usr/bin/node
command_args="/opt/sha/index.mjs"
command_user=sha:sha
directory=/var/lib/sha

output_log=/var/log/sha.log
error_log=/var/log/sha.log

depend() {
	need net localmount
	after firewall
}

start_pre() {
	checkpath -f -o $command_user "$output_log"
}
