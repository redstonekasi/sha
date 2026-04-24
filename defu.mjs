// Extremely stripped down version of defu for our purposes.

const isObject = (value) => typeof value === "object" && value !== null;
function _defu(baseObject, defaults) {
	if (!isObject(defaults)) {
		return _defu(baseObject, {});
	}
	const object = { ...defaults };
	for (const key of Object.keys(baseObject)) {
		const value = baseObject[key];
		if (value == null) continue;

		if (Array.isArray(value) && Array.isArray(object[key])) {
			object[key] = [...value, ...object[key]];
		} else if (isObject(value) && isObject(object[key])) {
			object[key] = _defu(value, object[key]);
		} else {
			object[key] = value;
		}
	}
	return object;
}
export const defu = (...arguments_) => arguments_.reduce((p, c) => _defu(p, c), {});
