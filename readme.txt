  REQUIREMENTS

* node.js 'jod' or later
* pnpm

  DEPLOY

cp index.mjs worker.js /opt/sha/
useradd -m -d /var/lib/sha -r -s /sbin/nologin sha
cp config.example.json /var/lib/sha/config.json

  CADDY

reverse_proxy /_internal/* localhost:9080
reverse_proxy localhost:9081

  SYSTEMD

[Unit]
Description=sheltupdate server supervisor (%i)
After=network.target

[Service]
Type=notify-reload
User=sha
ExecStart=/usr/bin/node /opt/sha/index.mjs %i
NotifyAccess=all
Restart=on-failure
RestartSec=5s

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

NODE="${SVCNAME#*.}"

command=/usr/bin/node
command_args="/opt/sha/index.mjs"
command_user=sha:sha
directory=/var/lib/sha

output_log=/var/log/sha.log
error_log=/var/log/sha.log

checkconfig() {
	if [ "$NODE" = "$SVCNAME" ]; then
		eerror "You must create a symbolic link to this init script with the node name:"
		eerror "  ln -s /etc/init.d/sha /etc/init.d/sha.release"
		eerror "And then instead call:"
		eerror "  rc-service sha.release start"
		return 1
	fi
	return 0
}

depend() {
	need net localmount
	after firewall
}

start_pre() {
	checkconfig || return 1
	checkpath -f -o $command_user "$output_log"
}
